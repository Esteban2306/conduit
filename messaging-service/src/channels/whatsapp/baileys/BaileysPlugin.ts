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
    return /^\d{10,15}$/.test(address.replace(/\D/g, ''));
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

    return this.limiter.enqueue(() => this.sendMessage(payload));
  }

  private async sendMessage(
    payload: ChannelSendPayload,
  ): Promise<ChannelSendResult> {
    try {
      const sock = this.session.getSocket()!;
      const jid = this.formatJid(payload.to);
      const text = this.stripHtml(payload.content);
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

  private formatJid(phone: string): string {
    return `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
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
