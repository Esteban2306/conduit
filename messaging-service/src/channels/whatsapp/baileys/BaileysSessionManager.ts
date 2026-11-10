import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import makeWASocket, {
  WASocket,
  WAMessage,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { hostname } from 'os';
import { randomUUID } from 'crypto';
import { Boom } from '@hapi/boom';
import { PrismaService } from 'src/shared/prisma.service';
import { BotRouter } from 'src/bot/router/BotRouter';
import { WhatsAppConnectionService } from '../WhatsAppConnection.service';
import { BaileysRateLimiter, WarmupLevel } from './BaileysRateLimiter';
import { SessionDecryptError, usePrismaAuthState } from './BaileysAuthState';
import { SecretEncryptionService } from 'src/shared/security/secret-encryption.service';
import { messageReceiptTracker } from './MessageReceiptTracker';
import { BaileysRateLimiterRegistry } from './BaileysRateLimiterRegistry';
import { BotSentMessageRegistry } from 'src/channels/whatsapp/baileys/BotSentMessageRegistry';
import {
  classifyDisconnect,
  countsAsFlap,
  DisconnectInfo,
  FlapDetector,
  FLAP_THRESHOLD,
  FORBIDDEN_CONFIRM_WINDOW_MS,
} from './disconnect-classifier';
import { OpsAlertService } from '../alerts/OpsAlert.service';
import { WhatsAppContactService } from '../contacts/WhatsAppContactService';
import { SentMessageStore } from './SentMessageStore';
import { TtlCacheStore } from './TtlCacheStore';
import {
  isIgnorableJid,
  isLidJid,
  isPhoneJid,
  jidUser,
  phoneToJid,
} from '../utils/jid.util';
import { chatKey } from '../utils/chat-key';

export interface NumberConflict {
  tenantId: string;
  newConnectionId: string;
  existing: { id: string; key: string | null; status: string };
  phoneNumber: string;
}

export type NumberConflictHandler = (conflict: NumberConflict) => void;

interface SocketState {
  botConfigId: string | null;
  tenantId: string;
  label: string;
  reconnectCount: number;
  lastReconnectAt: number | null;
  connectedAt: number | null;
  connected: boolean;
  stopped: boolean;
}

@Injectable()
export class BaileysSessionManager implements OnApplicationShutdown {
  private readonly logger = new Logger(BaileysSessionManager.name);
  private readonly sockets = new Map<string, WASocket>();
  private readonly states = new Map<string, SocketState>();
  private readonly starting = new Map<string, Promise<void>>();
  private botRouter: BotRouter | null = null;

  private readonly RECEIPT_MAX_AGE_MS = 5 * 60 * 1000;
  /**
   * Cierres que sugieren problemas con la cuenta o la red y suben el
   * riesgo del rate limiter. 440 (sesión reemplazada) y 403 (prohibido) se
   * tratan aparte deteniendo la conexión; 515 (reinicio requerido) es
   * normal tras emparejar y no es señal de riesgo.
   */
  private readonly INVALID_SESSION_CODES = [DisconnectReason.loggedOut, 401];

  /** Identidad de esta instancia para el lease de sesión. */
  private readonly instanceId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly LEASE_TTL_MS = 90_000;
  private readonly LEASE_RENEW_MS = 30_000;
  private readonly leaseTimer: NodeJS.Timeout;
  private readonly leaseRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly leaseWarned = new Set<string>();

  /** Cachés que deben sobrevivir a las reconexiones del socket. */
  private readonly msgRetryCaches = new Map<string, TtlCacheStore>();
  private readonly chatAddresses = new Map<string, string>();

  private readonly downTimers = new Map<string, NodeJS.Timeout>();
  private readonly DOWN_ALERT_MS = 10 * 60 * 1000;

  private readonly reconnectAttempts = new Map<string, number>();
  private readonly streakStartedAt = new Map<string, number>();
  private readonly stabilityTimers = new Map<string, NodeJS.Timeout>();
  private readonly STABLE_CONNECTION_MS = 5 * 60 * 1000;
  private readonly MAX_BACKOFF_MS = 5 * 60 * 1000;

  private readonly MAX_CONSECUTIVE_FAILURES = 6;
  private readonly STORM_WINDOW_MS = 5 * 60 * 1000;

  private readonly flaps = new FlapDetector();
  private readonly forbiddenSeenAt = new Map<string, number>();
  private readonly outdatedStreak = new Map<string, number>();
  private readonly FORBIDDEN_RECHECK_MS = 120_000;

  private readonly lastRiskReportAt = new Map<string, number>();
  private numberConflictHandler?: NumberConflictHandler;
  private readonly RISK_REPORT_COOLDOWN_MS = 5 * 60 * 1000;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly connections: WhatsAppConnectionService,
    private readonly limiter: BaileysRateLimiterRegistry,
    private readonly receiptTracker: messageReceiptTracker,
    private readonly botSentRegistry: BotSentMessageRegistry,
    private readonly contacts: WhatsAppContactService,
    private readonly sentMessages: SentMessageStore,
    private readonly alerts: OpsAlertService,
    private readonly encryption: SecretEncryptionService,
  ) {
    this.leaseTimer = setInterval(() => {
      void this.renewLeases();
    }, this.LEASE_RENEW_MS);
    this.leaseTimer.unref();
  }

  /**
   * Cierra los sockets sin hacer logout: la sesión queda guardada y el
   * estado en DB sigue CONNECTED para restaurarse al arrancar.
   */
  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.leaseTimer);
    for (const timer of this.leaseRetryTimers.values()) clearTimeout(timer);
    this.leaseRetryTimers.clear();

    const ids = [...this.sockets.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
    if (ids.length > 0) {
      this.logger.log(
        `Sesiones de WhatsApp cerradas ordenadamente: ${ids.length}`,
      );
    }
  }

  setBotRouter(router: BotRouter): void {
    this.botRouter = router;
  }

  setNumberConflictHandler(handler: NumberConflictHandler): void {
    this.numberConflictHandler = handler;
  }

  async start(connectionId: string): Promise<void> {
    if (this.sockets.has(connectionId)) return;

    const inProgress = this.starting.get(connectionId);
    if (inProgress) return inProgress;

    const startPromise = this.createSocket(connectionId).finally(() => {
      this.starting.delete(connectionId);
    });
    this.starting.set(connectionId, startPromise);
    return startPromise;
  }

  async stop(connectionId: string): Promise<void> {
    const state = this.states.get(connectionId);
    if (state) {
      state.stopped = true;
      state.connected = false;
    }

    const socket = this.sockets.get(connectionId);
    this.sockets.delete(connectionId);
    this.states.delete(connectionId);

    if (socket) {
      await socket.end(undefined).catch((error: unknown) => {
        this.logger.debug(
          `No fue posible detener ${connectionId}: ${this.errorMessage(error)}`,
        );
      });
    }

    this.clearRetryState(connectionId);
    this.clearDownAlert(connectionId);
    this.flaps.clear(connectionId);
    this.forbiddenSeenAt.delete(connectionId);
    this.outdatedStreak.delete(connectionId);
    const retry = this.leaseRetryTimers.get(connectionId);
    if (retry) clearTimeout(retry);
    this.leaseRetryTimers.delete(connectionId);

    await this.connections
      .releaseSessionLease(connectionId, this.instanceId)
      .catch((error: unknown) => {
        this.logger.warn(
          `No fue posible liberar el lease de ${connectionId}: ${this.errorMessage(error)}`,
        );
      });
  }

  async remove(connectionId: string): Promise<void> {
    await this.stop(connectionId);
    this.limiter.remove(connectionId);
    this.lastRiskReportAt.delete(connectionId);
  }

  async reconnect(connectionId: string): Promise<void> {
    await this.stop(connectionId);
    await this.start(connectionId);
  }

  get(connectionId: string): WASocket | undefined {
    return this.sockets.get(connectionId);
  }

  isConnected(connectionId: string): boolean {
    return this.states.get(connectionId)?.connected ?? false;
  }

  refreshBotConfigId(connectionId: string, botConfigId: string | null): void {
    const state = this.states.get(connectionId);
    if (!state) return;
    state.botConfigId = botConfigId;
    this.logger.log(
      `botConfigId actualizado en caliente para ${connectionId}: ${botConfigId ?? '(sin bot)'}`,
    );
  }

  private async createSocket(connectionId: string): Promise<void> {
    const connection =
      await this.connections.findForSessionManager(connectionId);
    if (!connection) {
      throw new Error(`La conexión ${connectionId} no existe.`);
    }

    const heldUntil = await this.connections.acquireSessionLease(
      connectionId,
      this.instanceId,
      this.LEASE_TTL_MS,
    );
    if (heldUntil) {
      this.scheduleLeaseRetry(connectionId, heldUntil);
      return;
    }
    this.leaseWarned.delete(connectionId);

    this.limiter.getOrCreate(
      connectionId,
      connection.warmupLevel as unknown as WarmupLevel,
    );
    await this.limiter.hydrate(connectionId).catch((error: unknown) => {
      this.logger.warn(
        `No fue posible recuperar el estado del limitador de ${connectionId}: ${this.errorMessage(error)}`,
      );
    });

    let session: Awaited<ReturnType<typeof usePrismaAuthState>>;
    try {
      session = await usePrismaAuthState(this.prisma, connectionId, {
        seal: (plain) => this.encryption.seal(plain),
        open: (stored) => this.encryption.open(stored),
      });
    } catch (error) {
      if (error instanceof SessionDecryptError) {
        this.logger.error(error.message);
        await this.connections
          .updateStatus(connectionId, 'ERROR')
          .catch(() => {});
        await this.connections
          .releaseSessionLease(connectionId, this.instanceId)
          .catch(() => {});
        this.alerts.report(
          connection.tenantId,
          'connection',
          `${connection.name}: no se puede leer la sesión guardada porque INTEGRATION_ENCRYPTION_KEY cambió; no se creó una sesión nueva. Restaura la clave original`,
          { immediate: true, dedupeKey: `${connectionId}:decrypt` },
        );
      }
      throw error;
    }
    const { state: authState, saveCreds } = session;
    if (session.restoredFromBackup() || session.identityLost) {
      this.alerts.report(
        connection.tenantId,
        'connection',
        session.identityLost
          ? `${connection.name}: las credenciales guardadas estaban dañadas y no había copia; habrá que escanear un QR nuevo`
          : `${connection.name}: las credenciales principales estaban dañadas y se restauró la copia de seguridad`,
        { immediate: true, dedupeKey: `${connectionId}:creds-recovery` },
      );
    }

    let version: [number, number, number] | undefined;

    try {
      const versionInfo = await fetchLatestBaileysVersion();
      version = versionInfo.version;
      this.logger.log(
        `Versión de protocolo WhatsApp Web: ${version.join('.')} | ¿es la más reciente conocida por la librería?: ${versionInfo.isLatest}`,
      );
    } catch (error) {
      this.logger.warn(
        `No fue posible consultar la versión vigente de WhatsApp Web, usando el valor por defecto de la librería: ${this.errorMessage(error)}`,
      );
    }

    const logger = this.buildSilentLogger();
    const socket = makeWASocket({
      auth: {
        creds: authState.creds,
        // Caché en memoria sobre las claves Signal de Postgres: menos
        // consultas por mensaje y lecturas consistentes bajo concurrencia.
        keys: makeCacheableSignalKeyStore(authState.keys as any, logger),
      },
      version,
      printQRInTerminal: false,
      logger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      retryRequestDelayMs: 2000,
      // Permite reenviar un mensaje cuando el teléfono del destinatario no
      // pudo descifrarlo; sin esto el cliente ve "Esperando este mensaje".
      getMessage: (key) => this.sentMessages.find(key.id),
      msgRetryCounterCache: this.retryCacheFor(connectionId),
    });

    const state: SocketState = {
      botConfigId: connection.botConfigId ?? null,
      tenantId: connection.tenantId,
      label: connection.name,
      reconnectCount: 0,
      lastReconnectAt: null,
      connectedAt: null,
      connected: false,
      stopped: false,
    };
    this.states.set(connectionId, state);
    this.sockets.set(connectionId, socket);
    this.bindEvents(connectionId, socket, state, saveCreds);
  }

  private bindEvents(
    connectionId: string,
    socket: WASocket,
    state: SocketState,
    saveCreds: () => Promise<void>,
  ): void {
    socket.ev.on('messages.update', (updates) => {
      for (const update of updates) {
        if (update.key.fromMe && update.update.status === 3) {
          const jid = update.key.remoteJidAlt ?? update.key.remoteJid;
          const justReconnected =
            state.lastReconnectAt && Date.now() - state.lastReconnectAt < 10000;
          if (jid && !justReconnected)
            this.receiptTracker.markChatActive(
              this.chatKeyFor(connectionId, jid),
            );
        }
      }
    });

    socket.ev.on('presence.update', ({ id, presences }) => {
      for (const presence of Object.values(presences)) {
        if (presence.lastKnownPresence === 'composing') {
          this.receiptTracker.markTyping(this.chatKeyFor(connectionId, id));
        } else if (
          presence.lastKnownPresence === 'paused' ||
          presence.lastKnownPresence === 'available'
        ) {
          this.receiptTracker.clearTyping(this.chatKeyFor(connectionId, id));
        }
      }
    });

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const message of messages) {
        if (isIgnorableJid(message.key.remoteJid)) continue;

        if (!message.key.fromMe) {
          await this.resolveAndRecordSender(connectionId, socket, message);
        }

        if (message.key.fromMe) {
          const messageId = message.key.id;
          const isSelfOriginated = messageId
            ? this.botSentRegistry.consume(messageId)
            : false;

          if (!isSelfOriginated && state.botConfigId) {
            const jid = message.key.remoteJidAlt ?? message.key.remoteJid;
            if (jid)
              this.receiptTracker.markChatActive(
                this.chatKeyFor(connectionId, jid),
              );
            await this.botRouter
              ?.registerHumanMessage(
                message,
                state.botConfigId,
                connectionId,
                state.tenantId,
              )
              .catch(() => {});
          }
          continue;
        }

        if (!state.botConfigId) {
          this.logger.debug(
            `Mensaje entrante en ${connectionId} ignorado: conexión sin bot asignado.`,
          );
          continue;
        }

        const MAX_MESSAGE_AGE_MS = 60 * 60 * 1000;

        const ageMs = Date.now() - Number(message.messageTimestamp ?? 0) * 1000;
        if (ageMs > MAX_MESSAGE_AGE_MS) {
          this.logger.debug(
            `Mensaje en ${connectionId}: antigüedad de ${Math.round(ageMs / 1000)}s supera el máximo permitido; se guarda sin responder.`,
          );
          await this.botRouter
            ?.recordMissedInbound(
              message,
              state.botConfigId,
              connectionId,
              state.tenantId,
            )
            .then((phone) => {
              if (phone)
                this.alerts.report(
                  state.tenantId,
                  'undelivered',
                  `${phone}: mensaje recibido hace ${Math.round(ageMs / 60000)} min sin responder`,
                );
            })
            .catch(() => {});
          continue;
        }

        if (message.key.remoteJid) {
          socket.presenceSubscribe(message.key.remoteJid).catch(() => {});
        }
        await this.botRouter
          ?.route([message], state.botConfigId, connectionId, state.tenantId)
          .catch((error: unknown) => {
            this.logger.error(`BotRouter error: ${this.errorMessage(error)}`);
          });
      }
    });

    socket.ev.on('message-receipt.update', (updates) => {
      for (const update of updates) {
        if (!update.key.fromMe || !update.receipt.readTimestamp) continue;
        const readTimestamp =
          typeof update.receipt.readTimestamp === 'number'
            ? update.receipt.readTimestamp
            : update.receipt.readTimestamp.toNumber();
        if (Date.now() - readTimestamp * 1000 > this.RECEIPT_MAX_AGE_MS)
          continue;

        const jid = update.key.remoteJidAlt ?? update.key.remoteJid;
        if (jid)
          this.receiptTracker.markChatActive(
            this.chatKeyFor(connectionId, jid),
          );
      }
    });

    socket.ev.on(
      'connection.update',
      async ({ connection, lastDisconnect, qr }) => {
        if (!this.isCurrentSocket(connectionId, socket) || state.stopped)
          return;

        if (qr) {
          await this.connections
            .updateQR(connectionId, qr)
            .catch((error: unknown) => {
              this.logger.error(
                `No fue posible guardar QR: ${this.errorMessage(error)}`,
              );
            });
        }

        if (connection === 'open') {
          state.reconnectCount++;
          state.connectedAt = Date.now();
          state.lastReconnectAt = Date.now();
          state.connected = true;
          this.clearDownAlert(connectionId);
          this.outdatedStreak.delete(connectionId);
          this.limiter.enterReconnectThrottle(connectionId);

          const phoneNumber =
            socket.user?.id?.split('@')[0].split(':')[0] ?? null;
          const { numberConflict } = await this.connections.markConnected(
            connectionId,
            phoneNumber,
          );
          if (numberConflict && phoneNumber) {
            await this.reportNumberConflict(connectionId, state, phoneNumber);
          }
          if (state.botConfigId) {
            void this.botRouter
              ?.recoverPending(connectionId, state.botConfigId, state.tenantId)
              .catch((error: unknown) => {
                this.logger.warn(
                  `No fue posible recuperar mensajes pendientes en ${connectionId}: ${this.errorMessage(error)}`,
                );
              });
          }
          this.logger.log(`WhatsApp conectado: ${connectionId}`);

          if (!state.botConfigId) {
            this.logger.warn(
              `Conexión ${connectionId} conectada sin bot asignado. ` +
                `Los mensajes entrantes no tendrán respuesta automática hasta asignar un bot.`,
            );
          }

          const existingTimer = this.stabilityTimers.get(connectionId);
          if (existingTimer) clearTimeout(existingTimer);

          const stabilityTimer = setTimeout(() => {
            this.clearRetryState(connectionId);
            this.logger.debug(
              `Conexión ${connectionId} estable por ${this.STABLE_CONNECTION_MS / 60000}min. Historial de reintentos limpiado.`,
            );
          }, this.STABLE_CONNECTION_MS);
          this.stabilityTimers.set(connectionId, stabilityTimer);
        }

        if (connection === 'close') {
          const code = (lastDisconnect?.error as Boom | undefined)?.output
            ?.statusCode;
          const reason = (lastDisconnect?.error as Boom | undefined)?.output
            ?.payload?.error;
          const info = classifyDisconnect(lastDisconnect?.error);
          state.connected = false;
          this.sockets.delete(connectionId);

          this.logger.warn(
            `Conexión cerrada: ${connectionId} | código: ${code ?? 'desconocido'} | razón: ${reason ?? 'n/a'}`,
          );

          await this.connections
            .updateStatus(connectionId, this.disconnectedStatus(), {
              disconnectedAt: new Date(),
            })
            .catch((error: unknown) => {
              this.logger.error(
                `No fue posible actualizar desconexión: ${this.errorMessage(error)}`,
              );
            });

          if (this.INVALID_SESSION_CODES.includes(code ?? -1)) {
            await this.prisma.whatsAppSession.deleteMany({
              where: { connectionId },
            });
          }

          if (state.stopped) return;

          if (code === DisconnectReason.loggedOut) {
            this.logger.error(
              `Conexión ${connectionId}: sesión cerrada desde el teléfono (401). Se requiere escanear un QR nuevo.`,
            );
            this.alertTeam(
              connectionId,
              state,
              'la sesión se cerró desde el teléfono (401); hay que escanear un QR nuevo y mientras tanto el bot no responde',
            );
            await this.haltConnection(connectionId, state, 'ERROR');
            return;
          }

          if (code === DisconnectReason.connectionReplaced) {
            this.logger.error(
              `Conexión ${connectionId}: otra instancia o dispositivo abrió esta misma sesión (440). ` +
                `Se detiene la reconexión automática para no entrar en un bucle de expulsiones, ` +
                `que WhatsApp asocia a automatización. Revisa que no haya otro Conduit usando la misma ` +
                `base de datos y reconecta manualmente.`,
            );
            this.alertTeam(
              connectionId,
              state,
              'otra instancia o dispositivo abrió la misma sesión (440); se detuvo la reconexión automática. Revisa que no haya dos Conduit con la misma base de datos',
            );
            await this.haltConnection(connectionId, state, 'ERROR');
            return;
          }

          if (info.kind === 'FORBIDDEN') {
            const previous = this.forbiddenSeenAt.get(connectionId);
            const confirmed =
              previous !== undefined &&
              Date.now() - previous < FORBIDDEN_CONFIRM_WINDOW_MS;
            if (confirmed) {
              this.logger.error(
                `Conexión ${connectionId}: WhatsApp rechazó la cuenta (403) dos veces seguidas. Posible bloqueo del número. ` +
                  `Se detiene toda actividad de esta conexión.`,
              );
              this.alertTeam(
                connectionId,
                state,
                'WhatsApp rechazó la cuenta (403) en dos intentos seguidos: posible bloqueo del número. Se detuvo toda la actividad',
              );
              await this.haltConnection(connectionId, state, 'BANNED');
              return;
            }
            this.forbiddenSeenAt.set(connectionId, Date.now());
            this.logger.warn(
              `Conexión ${connectionId}: WhatsApp respondió 403. Un solo 403 puede ser pasajero: se confirma con un segundo intento antes de darla por bloqueada.`,
            );
            await this.sleep(
              Math.round(
                this.FORBIDDEN_RECHECK_MS * (0.8 + Math.random() * 0.4),
              ),
            );
            if (state.stopped) return;
            await this.start(connectionId).catch((error: unknown) => {
              this.logger.error(
                `Error reconectando ${connectionId}: ${this.errorMessage(error)}`,
              );
            });
            return;
          }

          if (code === DisconnectReason.restartRequired) {
            // Normal tras emparejar el QR: reconectar ya, sin backoff ni riesgo.
            this.logger.log(
              `Conexión ${connectionId}: WhatsApp pidió reiniciar el socket (515). Reconectando.`,
            );
            await this.start(connectionId).catch((error: unknown) => {
              this.logger.error(
                `Error reconectando ${connectionId}: ${this.errorMessage(error)}`,
              );
            });
            return;
          }

          const existingTimer = this.stabilityTimers.get(connectionId);
          if (existingTimer) {
            clearTimeout(existingTimer);
            this.stabilityTimers.delete(connectionId);
          }

          const attempts = (this.reconnectAttempts.get(connectionId) ?? 0) + 1;
          this.reconnectAttempts.set(connectionId, attempts);

          if (attempts === 1) {
            this.streakStartedAt.set(connectionId, Date.now());
          }

          const streakStart =
            this.streakStartedAt.get(connectionId) ?? Date.now();
          const streakDurationMs = Date.now() - streakStart;

          if (
            attempts >= this.MAX_CONSECUTIVE_FAILURES &&
            streakDurationMs < this.STORM_WINDOW_MS
          ) {
            const neverAuthenticated = state.connectedAt === null;

            if (neverAuthenticated) {
              this.logger.error(
                `Conexión ${connectionId} nunca logró autenticarse en ${attempts} intentos. ` +
                  `Purgando credenciales — se requerirá escanear un QR nuevo.`,
              );
              await this.prisma.whatsAppSession
                .deleteMany({ where: { connectionId } })
                .catch((error: unknown) => {
                  this.logger.error(
                    `No fue posible purgar sesión corrupta de ${connectionId}: ${this.errorMessage(error)}`,
                  );
                });
            }

            this.logger.error(
              `Conexión ${connectionId} entra en CUARENTENA tras ${attempts} fallos consecutivos en ${Math.round(streakDurationMs / 1000)}s (código más reciente: ${code}). ` +
                `Auto-reconexión detenida. Requiere reconexión manual vía API.`,
            );

            await this.connections
              .updateStatus(connectionId, 'ERROR' as const)
              .catch(() => {});

            this.reportRiskOncePerCooldown(connectionId, code);
            this.alertTeam(
              connectionId,
              state,
              `entró en cuarentena tras ${attempts} fallos de conexión seguidos (código ${code ?? 'desconocido'}); requiere reconexión manual`,
            );

            state.stopped = true;
            this.states.delete(connectionId);
            this.clearRetryState(connectionId);
            return;
          }

          this.noteDisconnect(connectionId, state, info);

          const backoff = Math.round(
            Math.min(
              5000 * Math.pow(2, Math.max(attempts - 1, 0)),
              this.MAX_BACKOFF_MS,
            ) *
              (0.8 + Math.random() * 0.4),
          );
          this.scheduleDownAlert(connectionId, state);

          this.logger.debug(
            `Reintento #${attempts} para ${connectionId} en ${Math.round(backoff / 1000)}s`,
          );

          await this.sleep(backoff);
          if (state.stopped) return;

          await this.connections
            .updateStatus(connectionId, this.connectingStatus())
            .catch(() => {});
          await this.start(connectionId).catch((error: unknown) => {
            this.logger.error(
              `Error reconectando ${connectionId}: ${this.errorMessage(error)}`,
            );
          });
        }
      },
    );

    socket.ev.on('creds.update', saveCreds);
  }

  /**
   * Resuelve el teléfono real del remitente. Con LID, WhatsApp oculta el
   * número: se intenta el mapeo LID→teléfono de Baileys y luego el último
   * conocido en los contactos. Si se resuelve, se deja en `remoteJidAlt`
   * para que el bot identifique al cliente por su teléfono.
   */
  private async resolveAndRecordSender(
    connectionId: string,
    socket: WASocket,
    message: WAMessage,
  ): Promise<void> {
    try {
      const { remoteJid, remoteJidAlt } = message.key;
      const lidJid = [remoteJid, remoteJidAlt].find(isLidJid);
      let phoneJid = [remoteJid, remoteJidAlt].find(isPhoneJid);
      const lid = lidJid ? jidUser(lidJid) : null;

      if (!phoneJid && lidJid) {
        const mapped = await socket.signalRepository.lidMapping
          .getPNForLID(lidJid)
          .catch(() => null);
        if (mapped) {
          phoneJid = phoneToJid(jidUser(mapped));
        } else if (lid) {
          const known = await this.contacts.findAddressByLid(connectionId, lid);
          if (known) phoneJid = phoneToJid(known);
        }
      }

      if (!phoneJid) {
        this.logger.debug(
          `Remitente ${remoteJid} sin teléfono resoluble (LID); se atiende por LID.`,
        );
        return;
      }

      if (!isPhoneJid(message.key.remoteJidAlt)) {
        message.key.remoteJidAlt = phoneJid;
      }
      if (lid) {
        this.chatAddresses.set(`${connectionId}|${lid}`, jidUser(phoneJid));
      }
      await this.contacts.recordInbound(connectionId, jidUser(phoneJid), lid);
    } catch (error) {
      this.logger.warn(
        `No fue posible registrar el remitente en ${connectionId}: ${this.errorMessage(error)}`,
      );
    }
  }

  private chatKeyFor(connectionId: string, jid: string): string {
    if (isLidJid(jid)) {
      const phone = this.chatAddresses.get(`${connectionId}|${jidUser(jid)}`);
      if (phone) return chatKey(connectionId, phoneToJid(phone));
    }
    return chatKey(connectionId, jid);
  }

  private async reportNumberConflict(
    connectionId: string,
    state: SocketState,
    phoneNumber: string,
  ): Promise<void> {
    const other = await this.connections
      .findByPhoneNumber(state.tenantId, phoneNumber)
      .catch(() => null);
    const otherLabel = other
      ? `${other.id}${other.key ? ` (${other.key})` : ''}, estado ${other.status}`
      : 'otra conexión del mismo tenant';
    this.alertTeam(
      connectionId,
      state,
      `el número ${phoneNumber} ya pertenece a ${otherLabel}; esta conexión quedó conectada sin guardar el número. ` +
        `Fusiónala con POST whatsapp/connections/${other?.id ?? '<id-existente>'}/adopt/${connectionId} para conservar el id, bot y bajas de la línea original`,
    );
    if (other && this.numberConflictHandler) {
      try {
        this.numberConflictHandler({
          tenantId: state.tenantId,
          newConnectionId: connectionId,
          existing: other,
          phoneNumber,
        });
      } catch (error) {
        this.logger.error(
          `El manejador de conflicto de número falló: ${this.errorMessage(error)}`,
        );
      }
    }
  }

  private alertTeam(
    connectionId: string,
    state: SocketState,
    text: string,
  ): void {
    this.alerts.report(
      state.tenantId,
      'connection',
      `${state.label}: ${text}`,
      { immediate: true, dedupeKey: `${connectionId}:${text}` },
    );
  }

  private scheduleDownAlert(connectionId: string, state: SocketState): void {
    if (this.downTimers.has(connectionId)) return;
    const timer = setTimeout(() => {
      this.downTimers.delete(connectionId);
      if (!state.connected && !state.stopped) {
        this.alertTeam(
          connectionId,
          state,
          `sin conexión desde hace ${Math.round(this.DOWN_ALERT_MS / 60000)} minutos; los mensajes de los clientes esperan sin respuesta`,
        );
      }
    }, this.DOWN_ALERT_MS);
    timer.unref();
    this.downTimers.set(connectionId, timer);
  }

  private clearDownAlert(connectionId: string): void {
    const timer = this.downTimers.get(connectionId);
    if (timer) clearTimeout(timer);
    this.downTimers.delete(connectionId);
  }

  /** Detiene la conexión sin reintentar y deja el estado para intervención humana. */
  private async haltConnection(
    connectionId: string,
    state: SocketState,
    status: 'ERROR' | 'BANNED',
  ): Promise<void> {
    state.stopped = true;
    this.states.delete(connectionId);
    this.clearRetryState(connectionId);
    await this.connections.updateStatus(connectionId, status).catch(() => {});
    await this.connections
      .releaseSessionLease(connectionId, this.instanceId)
      .catch(() => {});
    if (status === 'BANNED') this.reportRiskOncePerCooldown(connectionId, 403);
  }

  private retryCacheFor(connectionId: string): TtlCacheStore {
    let cache = this.msgRetryCaches.get(connectionId);
    if (!cache) {
      cache = new TtlCacheStore(60 * 60 * 1000);
      this.msgRetryCaches.set(connectionId, cache);
    }
    return cache;
  }

  /** Reintenta abrir la sesión cuando venza el lease de la otra instancia. */
  private scheduleLeaseRetry(connectionId: string, heldUntil: Date): void {
    const message =
      `Conexión ${connectionId}: la sesión la tiene otra instancia de Conduit ` +
      `hasta ${heldUntil.toISOString()}. No se abre un segundo socket (provocaría ` +
      `expulsiones 440); se reintenta al vencer el lease.`;
    if (this.leaseWarned.has(connectionId)) this.logger.debug(message);
    else this.logger.warn(message);
    this.leaseWarned.add(connectionId);

    const previous = this.leaseRetryTimers.get(connectionId);
    if (previous) clearTimeout(previous);

    const delay = Math.max(heldUntil.getTime() - Date.now(), 0) + 2_000;
    const timer = setTimeout(() => {
      this.leaseRetryTimers.delete(connectionId);
      void this.start(connectionId).catch((error: unknown) => {
        this.logger.error(
          `Error reintentando abrir ${connectionId}: ${this.errorMessage(error)}`,
        );
      });
    }, delay);
    timer.unref();
    this.leaseRetryTimers.set(connectionId, timer);
  }

  /** Renueva el lease de las sesiones abiertas; si se perdió, cierra el socket. */
  private async renewLeases(): Promise<void> {
    for (const connectionId of [...this.sockets.keys()]) {
      try {
        const heldUntil = await this.connections.acquireSessionLease(
          connectionId,
          this.instanceId,
          this.LEASE_TTL_MS,
        );
        if (heldUntil) {
          this.logger.error(
            `Conexión ${connectionId}: otra instancia tomó la sesión. Se cierra el socket local.`,
          );
          const state = this.states.get(connectionId);
          if (state) {
            this.alertTeam(
              connectionId,
              state,
              'otra instancia de Conduit tomó la sesión; se cerró el socket local para evitar expulsiones (440)',
            );
          }
          await this.stop(connectionId);
          this.scheduleLeaseRetry(connectionId, heldUntil);
        }
      } catch (error) {
        this.logger.warn(
          `No fue posible renovar el lease de ${connectionId}: ${this.errorMessage(error)}`,
        );
      }
    }
  }

  private isCurrentSocket(connectionId: string, socket: WASocket): boolean {
    return this.sockets.get(connectionId) === socket;
  }

  /**
   * Un cierre de red o de protocolo no es una señal de bloqueo y no frena las
   * respuestas. Solo una conexión que no se sostiene (varios cierres en pocos
   * minutos) sube el riesgo, y un 405 repetido avisa de que la versión del
   * protocolo quedó vieja.
   */
  private noteDisconnect(
    connectionId: string,
    state: SocketState,
    info: DisconnectInfo,
  ): void {
    if (info.kind === 'OUTDATED_VERSION') {
      const streak = (this.outdatedStreak.get(connectionId) ?? 0) + 1;
      this.outdatedStreak.set(connectionId, streak);
      if (streak === 3) {
        this.alertTeam(
          connectionId,
          state,
          'WhatsApp rechaza la versión del protocolo (405) en 3 intentos: hay que actualizar Baileys. No es un bloqueo del número',
        );
      }
    }

    if (!countsAsFlap(info.kind)) return;
    const closes = this.flaps.record(connectionId);
    if (closes < FLAP_THRESHOLD) {
      this.logger.debug(
        `Cierre ${info.kind} (${info.code ?? 'sin código'}) en ${connectionId}: protocolo normal, ${closes} en la ventana`,
      );
      return;
    }
    this.alertTeam(
      connectionId,
      state,
      `la conexión se cayó ${closes} veces en 10 minutos (${info.kind}); está inestable, pero no es una señal de bloqueo`,
    );
    this.reportRiskOncePerCooldown(connectionId, info.code);
  }

  private reportRiskOncePerCooldown(
    connectionId: string,
    code: number | undefined,
  ): void {
    const lastReport = this.lastRiskReportAt.get(connectionId) ?? 0;
    if (Date.now() - lastReport < this.RISK_REPORT_COOLDOWN_MS) {
      this.logger.debug(
        `Código ${code} detectado, pero suprimido por cooldown de riesgo (racha ya reportada) para ${connectionId}`,
      );
      return;
    }
    this.lastRiskReportAt.set(connectionId, Date.now());
    this.logger.warn(
      `Código ${code} clasificado como señal de riesgo para ${connectionId}`,
    );
    this.limiter.reportDisconnect(connectionId);
  }

  private clearRetryState(connectionId: string): void {
    const stabilityTimer = this.stabilityTimers.get(connectionId);
    if (stabilityTimer) clearTimeout(stabilityTimer);
    this.stabilityTimers.delete(connectionId);
    this.reconnectAttempts.delete(connectionId);
    this.streakStartedAt.delete(connectionId);
  }

  private disconnectedStatus() {
    return 'DISCONNECTED' as const;
  }

  private connectingStatus() {
    return 'CONNECTING' as const;
  }

  private buildSilentLogger() {
    const silentLogger: any = {
      level: 'silent',
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: (...args: unknown[]) => {
        const text = this.formatPinoArgs(args);
        if (
          !['failed to find key', 'msgId', 'no name present'].some((item) =>
            text.includes(item),
          )
        ) {
          this.logger.warn(text);
        }
      },
      error: (...args: unknown[]) => {
        const text = this.formatPinoArgs(args);
        if (
          !['PreKeyError', 'SessionError', 'isSessionRecordError'].some(
            (item) => text.includes(item),
          )
        ) {
          this.logger.error(text);
        }
      },
      fatal: (...args: unknown[]) =>
        this.logger.fatal(this.formatPinoArgs(args)),
    };
    silentLogger.child = () => silentLogger;
    return silentLogger;
  }

  private formatPinoArgs(args: unknown[]): string {
    if (args.length === 0) return '';

    const [first, second] = args;

    if (typeof first === 'string') return first;

    const objPart =
      first && typeof first === 'object' ? this.safeStringify(first) : '';
    const msgPart = typeof second === 'string' ? second : '';

    return (
      [msgPart, objPart].filter(Boolean).join(' | ') || this.errorMessage(first)
    );
  }

  private safeStringify(obj: unknown): string {
    try {
      return JSON.stringify(obj);
    } catch {
      return String(obj);
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
