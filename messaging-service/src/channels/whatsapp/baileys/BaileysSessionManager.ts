import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as path from 'path';
import * as fs from 'fs';
import * as qrcode from 'qrcode-terminal';
import { BaileysRateLimiter, WarmupLevel } from './BaileysRateLimiter';

@Injectable()
export class BaileysSessionManager implements OnModuleInit {
  private readonly logger = new Logger(BaileysSessionManager.name);
  private sock: WASocket | null = null;
  private isConnected = false;
  private readonly SESSION_PATH: string;

  constructor(
    private readonly config: ConfigService,
    private readonly limiter: BaileysRateLimiter,
  ) {
    const customPath = this.config.get<string>('whatsapp.sessionPath');
    this.SESSION_PATH = customPath
      ? path.resolve(customPath)
      : path.join(process.cwd(), 'baileys_session');
  }

  async onModuleInit(): Promise<void> {
    this.ensureSessionDirectory();

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
    this.logger.warn('Reiniciando sesión de WhatsApp...');
    await this.sock?.logout().catch(() => {});
    fs.rmSync(this.SESSION_PATH, { recursive: true, force: true });
    this.ensureSessionDirectory();
    await this.connect();
  }

  private ensureSessionDirectory(): void {
    if (!fs.existsSync(this.SESSION_PATH)) {
      fs.mkdirSync(this.SESSION_PATH, { recursive: true });
      this.logger.log(`Directorio de sesión creado: ${this.SESSION_PATH}`);
    }
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.SESSION_PATH);

    const silentLogger = this.buildSilentLogger();

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: silentLogger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.logger.log('Escanea el QR con WhatsApp para conectar');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'open') {
        this.isConnected = true;
        this.logger.log('WhatsApp conectado');
      }

      if (connection === 'close') {
        this.isConnected = false;
        const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = code !== DisconnectReason.loggedOut;

        this.logger.warn(
          `Desconectado. Código: ${code}. Reconectar: ${shouldReconnect}`,
        );

        if (shouldReconnect) {
          await this.sleep(5000);
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
        this.logger.warn(text);
      },
      error: (msg: unknown) => {
        const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
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
