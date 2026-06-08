import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import makeWASocket, {
  DisconnectReason,
  WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as qrcode from 'qrcode-terminal';
import { BaileysRateLimiter, WarmupLevel } from './BaileysRateLimiter';
import { usePrismaAuthState } from './BaileysAuthState';
import { PrismaService } from 'src/shared/prisma.service';

@Injectable()
export class BaileysSessionManager implements OnModuleInit {
  private readonly logger = new Logger(BaileysSessionManager.name);
  private sock: WASocket | null = null;
  private isConnected = false;
  private reconnectCount = 0;
  private lastReconnectAt: number | null = null;
  private sessionResetAttempts = 0;

  private readonly MAX_RESET_ATTEMPTS = 3;
  private readonly BAN_WARNING_CODES = [403, 405, 408, 440, 500, 515];
  private readonly INVALID_SESSION_CODES = [DisconnectReason.loggedOut, 401];

  constructor(
    private readonly config: ConfigService,
    private readonly limiter: BaileysRateLimiter,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const level = this.config.get<string>('whatsapp.warmupLevel') ?? 'NORMAL';
    this.limiter.setWarmupLevel(level as WarmupLevel);
    await this.connect();
  }

  getSocket(): WASocket | null {
    return this.sock;
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  async resetSession(): Promise<void> {
    if (this.sessionResetAttempts >= this.MAX_RESET_ATTEMPTS) {
      this.logger.error(
        `Máximo de reseteos alcanzado (${this.MAX_RESET_ATTEMPTS}). Intervención manual requerida.`,
      );
      return;
    }

    this.sessionResetAttempts++;
    this.isConnected = false;

    this.logger.warn(
      `Reiniciando sesión (intento ${this.sessionResetAttempts}/${this.MAX_RESET_ATTEMPTS})`,
    );

    try {
      await this.sock?.logout();
    } catch {
      this.logger.warn(
        'No fue posible cerrar sesión limpiamente. Continuando.',
      );
    }

    this.sock = null;

    await this.prisma.whatsAppSession.deleteMany({
      where: { id: { startsWith: 'default-session:' } },
    });

    this.logger.log('Sesión eliminada de DB. Reconectando para nuevo QR...');
    await this.connect();
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await usePrismaAuthState(this.prisma as any);
    const silentLogger = this.buildSilentLogger();

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: silentLogger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      retryRequestDelayMs: 2000,
    });

    this.sock.ev.on('messages.upsert', ({ messages }) => {});

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.logger.log('Escanea el QR con WhatsApp para conectar');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        this.sessionResetAttempts = 0;
        this.isConnected = true;
        this.reconnectCount++;
        this.lastReconnectAt = Date.now();
        this.logger.log('WhatsApp conectado');

        if (this.reconnectCount > 1) {
          this.limiter.enterReconnectThrottle();
        }
      }

      if (connection === 'close') {
        this.isConnected = false;
        const code = (lastDisconnect?.error as Boom)?.output?.statusCode;

        this.logger.warn(`Desconectado. Código: ${code}`);

        if (this.BAN_WARNING_CODES.includes(code)) {
          this.logger.error(
            `ALERTA BAN: código ${code}. Activando modo seguro.`,
          );
          this.limiter.reportDisconnect();
          this.limiter.reportDisconnect();
        } else {
          this.limiter.reportDisconnect();
        }

        if (this.INVALID_SESSION_CODES.includes(code ?? -1)) {
          this.logger.warn(`Sesión inválida (${code}). Regenerando QR.`);
          await this.resetSession();
          return;
        }

        const backoff = Math.min(
          5000 * Math.pow(2, this.reconnectCount - 1),
          60000,
        );

        if (code !== DisconnectReason.loggedOut) {
          this.logger.log(`Reconectando en ${Math.round(backoff / 1000)}s...`);
          await this.sleep(backoff);
          await this.connect();
        } else {
          this.logger.error('Sesión cerrada manualmente. Requiere nuevo QR.');
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);
  }

  private buildSilentLogger() {
    const silentLogger: any = {
      level: 'silent',
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: (msg: unknown) => {
        const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
        if (text.includes('failed to find key')) return;
        if (text.includes('msgId')) return;
        if (text.includes('no name present')) return;
        if (text.includes('Buffer timeout')) return;
        if (text.includes('USync fetch yielded')) return;
        this.logger.warn(text);
      },
      error: (msg: unknown) => {
        const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
        if (text.includes('PreKeyError')) return;
        if (text.includes('SessionError')) return;
        if (text.includes('isSessionRecordError')) return;
        this.logger.error(text);
      },
      fatal: (msg: unknown) => {
        const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
        this.logger.fatal(text);
      },
    };
    silentLogger.child = () => silentLogger;
    return silentLogger;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
