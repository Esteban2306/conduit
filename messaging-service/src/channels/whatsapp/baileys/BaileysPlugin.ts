import { Injectable, Logger } from '@nestjs/common';
import {
  ChannelSendPayload,
  ChannelSendResult,
  IChannelPlugin,
} from 'src/channels/types/IChannelPlugin';
import { BaileysRateLimiter } from './BaileysRateLimiter';
import { BaileysSessionManager } from './BaileysSessionManager';

@Injectable()
export class BaileysPlugin implements IChannelPlugin {
  readonly channel = 'WHATSAPP';
  readonly providerName = 'baileys';

  private readonly logger = new Logger(BaileysPlugin.name);

  constructor(
    private readonly limiter: BaileysRateLimiter,
    private readonly session: BaileysSessionManager,
  ) {}

  validateRecipient(address: string): boolean {
    return /^[1-9]\d{9,14}$/.test(address);
  }

  async send(payload: ChannelSendPayload): Promise<ChannelSendResult> {
    if (!this.session.getIsConnected() || !this.session.getSocket()) {
      return {
        success: false,
        provider: this.providerName,
        retryable: true,
        errorCode: 'WHATSAPP_NOT_CONNECTED',
        error: 'WhatsApp no está conectado. Escanea el QR para reconectar.',
        raw: null,
      };
    }

    if (!this.validateRecipient(payload.to)) {
      return {
        success: false,
        provider: this.providerName,
        retryable: false,
        errorCode: 'INVALID_RECIPIENT',
        error: `Número inválido: ${payload.to}`,
        raw: null,
      };
    }

    const hasWhatsaApp = await this.checkWhatsAppAccount(payload.to);
    if (!hasWhatsaApp) {
      return {
        success: false,
        provider: this.providerName,
        retryable: false,
        errorCode: 'NO_WHATSAPP_ACCOUNT',
        error: `El número ${payload.to} no tiene una cuenta de WhatsApp asociada.`,
        raw: null,
      };
    }

    return this.limiter.enqueue(() => this.sendMessage(payload));
  }

  private async sendMessage(
    payload: ChannelSendPayload,
  ): Promise<ChannelSendResult> {
    try {
      const sock = this.session.getSocket()!;
      const jid = this.formatJid(payload.to);
      const text = this.addInvisibleVariation(this.stripHtml(payload.content));

      await sock.sendPresenceUpdate('composing', jid);
      const typingMs =
        Math.min(text.length * 40, 4000) + this.randomInt(500, 1500);

      await this.sleep(typingMs);
      await sock.sendPresenceUpdate('paused', jid);

      const response = await sock.sendMessage(jid, { text });

      return {
        success: true,
        provider: this.providerName,
        providerMessageId: response?.key?.id ?? undefined,
        raw: response,
      };
    } catch (error) {
      const isConnectionError = error?.message?.includes('Connection');
      this.logger.error(`Send error: ${error?.message}`);

      return {
        success: false,
        provider: this.providerName,
        retryable: isConnectionError,
        errorCode: isConnectionError ? 'CONNECTION_ERROR' : 'SEND_FAILED',
        error: error instanceof Error ? error.message : 'Unknown error',
        raw: error,
      };
    }
  }

  private async checkWhatsAppAccount(phone: string): Promise<boolean> {
    try {
      const sock = this.session.getSocket()!;
      const clean = phone.replace(/\D/g, '');
      const waResult = await sock.onWhatsApp(clean);
      if (!waResult || waResult.length === 0) {
        return false;
      }
      const [result] = waResult;
      return result.exists ?? false;
    } catch {
      return true;
    }
  }

  private formatJid(phone: string): string {
    return `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
  }

  private randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private addInvisibleVariation(text: string): string {
    const invisibleChars = ['\u200B', '\u200C', '\u200D', '\uFEFF'];

    const count = this.randomInt(1, 3);
    let suffix = '';
    for (let i = 0; i < count; i++) {
      suffix += invisibleChars[this.randomInt(0, invisibleChars.length - 1)];
    }
    return text + suffix;
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
  }
}
