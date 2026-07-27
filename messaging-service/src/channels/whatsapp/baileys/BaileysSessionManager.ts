import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import makeWASocket, {
  DisconnectReason,
  WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { PrismaService } from 'src/shared/prisma.service';
import { BotRouter } from 'src/bot/router/BotRouter';
import { WhatsAppConnectionService } from '../WhatsAppConnection.service';
import { BaileysRateLimiter, WarmupLevel } from './BaileysRateLimiter';
import { usePrismaAuthState } from './BaileysAuthState';
import { messageReceiptTracker } from './MessageReceiptTracker';
import { BaileysRateLimiterRegistry } from './BaileysRateLimiterRegistry';

interface SocketState {
  botConfigId: string;
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

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly connections: WhatsAppConnectionService,
    private readonly limiter: BaileysRateLimiterRegistry,
    private readonly receiptTracker: messageReceiptTracker,
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
  }

  async remove(connectionId: string): Promise<void> {
    await this.stop(connectionId);
    this.limiter.remove(connectionId);
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
    const socket = makeWASocket({
      auth: authState,
      printQRInTerminal: false,
      logger: this.buildSilentLogger(),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      retryRequestDelayMs: 2000,
    });

    const state: SocketState = {
      botConfigId: connection.botConfigId,
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
          const jid = message.key.remoteJidAlt ?? message.key.remoteJid;
          if (jid) this.receiptTracker.markChatActive(jid);
          await this.botRouter
            ?.registerHumanMessage(message, state.botConfigId, connectionId)
            .catch(() => {});
          continue;
        }

        const ageMs = Date.now() - Number(message.messageTimestamp ?? 0) * 1000;
        const isStartupCatchup =
          state.connectedAt !== null &&
          Date.now() - state.connectedAt < 30000 &&
          ageMs > 5 * 60 * 1000;
        if (isStartupCatchup) continue;

        if (message.key.remoteJid) {
          socket.presenceSubscribe(message.key.remoteJid).catch(() => {});
        }
        await this.botRouter
          ?.route([message], state.botConfigId, connectionId)
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
        }

        if (connection === 'close') {
          const code = (lastDisconnect?.error as Boom | undefined)?.output
            ?.statusCode;
          const reason = (lastDisconnect?.error as Boom | undefined)?.output
            ?.payload?.error;
          state.connected = false;
          this.sockets.delete(connectionId);

          this.logger.warn(
            `Conexión cerrada: ${connectionId} | código: ${code ?? 'desconocido'} | razón: ${reason ?? 'n/a'} | reconexión #${state.reconnectCount}`,
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

          this.reportDisconnect(connectionId, code);
          if (this.INVALID_SESSION_CODES.includes(code ?? -1)) {
            await this.prisma.whatsAppSession.deleteMany({
              where: { connectionId },
            });
          }

          if (code === DisconnectReason.loggedOut || state.stopped) return;

          const backoff = Math.min(
            5000 * Math.pow(2, Math.max(state.reconnectCount - 1, 0)),
            60000,
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
    if (code && this.BAN_WARNING_CODES.includes(code)) {
      this.logger.warn(
        `Código ${code} clasificado como señal de riesgo para ${connectionId}`,
      );
      this.limiter.reportDisconnect(connectionId);
    } else {
      this.logger.debug(
        `Código ${code ?? 'desconocido'} no clasificado como riesgo para ${connectionId} — reconexión benigna`,
      );
    }
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
        const text = this.errorMessage(args);
        if (
          !['failed to find key', 'msgId', 'no name present'].some((item) =>
            text.includes(item),
          )
        ) {
          this.logger.warn(text);
        }
      },
      error: (...args: unknown[]) => {
        const text = this.errorMessage(args);
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
