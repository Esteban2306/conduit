import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import makeWASocket, {
  WASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { PrismaService } from 'src/shared/prisma.service';
import { BotRouter } from 'src/bot/router/BotRouter';
import { WhatsAppConnectionService } from '../WhatsAppConnection.service';
import { BaileysRateLimiter, WarmupLevel } from './BaileysRateLimiter';
import { usePrismaAuthState } from './BaileysAuthState';
import { messageReceiptTracker } from './MessageReceiptTracker';
import { BaileysRateLimiterRegistry } from './BaileysRateLimiterRegistry';
import { BotSentMessageRegistry } from 'src/channels/whatsapp/baileys/BotSentMessageRegistry';

interface SocketState {
  botConfigId: string | null;
  tenantId: string;
  reconnectCount: number;
  lastReconnectAt: number | null;
  connectedAt: number | null;
  connected: boolean;
  stopped: boolean;
}

@Injectable()
export class BaileysSessionManager {
  private readonly logger = new Logger(BaileysSessionManager.name);
  private readonly sockets = new Map<string, WASocket>();
  private readonly states = new Map<string, SocketState>();
  private readonly starting = new Map<string, Promise<void>>();
  private botRouter: BotRouter | null = null;

  private readonly RECEIPT_MAX_AGE_MS = 5 * 60 * 1000;
  private readonly BAN_WARNING_CODES = [403, 405, 408, 440, 500, 515];
  private readonly INVALID_SESSION_CODES = [DisconnectReason.loggedOut, 401];

  private readonly reconnectAttempts = new Map<string, number>();
  private readonly streakStartedAt = new Map<string, number>();
  private readonly stabilityTimers = new Map<string, NodeJS.Timeout>();
  private readonly STABLE_CONNECTION_MS = 5 * 60 * 1000;
  private readonly MAX_BACKOFF_MS = 5 * 60 * 1000;

  private readonly MAX_CONSECUTIVE_FAILURES = 6;
  private readonly STORM_WINDOW_MS = 5 * 60 * 1000;

  private readonly lastRiskReportAt = new Map<string, number>();
  private readonly RISK_REPORT_COOLDOWN_MS = 5 * 60 * 1000;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly connections: WhatsAppConnectionService,
    private readonly limiter: BaileysRateLimiterRegistry,
    private readonly receiptTracker: messageReceiptTracker,
    private readonly botSentRegistry: BotSentMessageRegistry,
  ) {}

  setBotRouter(router: BotRouter): void {
    this.botRouter = router;
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

    this.limiter.getOrCreate(
      connectionId,
      connection.warmupLevel as unknown as WarmupLevel,
    );

    const { state: authState, saveCreds } = await usePrismaAuthState(
      this.prisma,
      connectionId,
    );

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

    const socket = makeWASocket({
      auth: authState,
      version,
      printQRInTerminal: false,
      logger: this.buildSilentLogger(),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      retryRequestDelayMs: 2000,
    });

    const state: SocketState = {
      botConfigId: connection.botConfigId ?? null,
      tenantId: connection.tenantId,
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
          if (jid && !justReconnected) this.receiptTracker.markChatActive(jid);
        }
      }
    });

    socket.ev.on('presence.update', ({ id, presences }) => {
      for (const presence of Object.values(presences)) {
        if (presence.lastKnownPresence === 'composing') {
          this.receiptTracker.markTyping(id);
        } else if (
          presence.lastKnownPresence === 'paused' ||
          presence.lastKnownPresence === 'available'
        ) {
          this.receiptTracker.clearTyping(id);
        }
      }
    });

    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const message of messages) {
        if (message.key.fromMe) {
          const messageId = message.key.id;
          const isSelfOriginated = messageId
            ? this.botSentRegistry.consume(messageId)
            : false;

          if (!isSelfOriginated && state.botConfigId) {
            const jid = message.key.remoteJidAlt ?? message.key.remoteJid;
            if (jid) this.receiptTracker.markChatActive(jid);
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
            `Mensaje descartado en ${connectionId}: antigüedad de ${Math.round(ageMs / 1000)}s supera el máximo permitido (posible backlog mal etiquetado por WhatsApp como 'notify').`,
          );
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
        if (jid) this.receiptTracker.markChatActive(jid);
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
          if (state.reconnectCount > 1) {
            this.limiter.enterReconnectThrottle(connectionId);
          }

          const phoneNumber =
            socket.user?.id?.split('@')[0].split(':')[0] ?? null;
          await this.connections.markConnected(connectionId, phoneNumber);
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

          if (code === DisconnectReason.loggedOut || state.stopped) return;

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

            state.stopped = true;
            this.states.delete(connectionId);
            this.clearRetryState(connectionId);
            return;
          }

          this.reportDisconnect(connectionId, code);

          const backoff = Math.min(
            5000 * Math.pow(2, Math.max(attempts - 1, 0)),
            this.MAX_BACKOFF_MS,
          );

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

  private isCurrentSocket(connectionId: string, socket: WASocket): boolean {
    return this.sockets.get(connectionId) === socket;
  }

  private reportDisconnect(
    connectionId: string,
    code: number | undefined,
  ): void {
    if (!code || !this.BAN_WARNING_CODES.includes(code)) {
      this.logger.debug(
        `Código ${code ?? 'desconocido'} no clasificado como riesgo para ${connectionId} — reconexión benigna`,
      );
      return;
    }
    this.reportRiskOncePerCooldown(connectionId, code);
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
