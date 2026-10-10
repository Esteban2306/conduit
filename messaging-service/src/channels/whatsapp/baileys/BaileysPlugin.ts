import { Injectable, Logger } from '@nestjs/common';
import {
  ChannelSendPayload,
  ChannelSendResult,
  IChannelPlugin,
} from 'src/channels/types/IChannelPlugin';
import { BaileysRateLimiterRegistry } from './BaileysRateLimiterRegistry';
import { JobPriority, WarmupLevel } from './BaileysRateLimiter';
import { BaileysSessionManager } from './BaileysSessionManager';
import { WASocket } from '@whiskeysockets/baileys';
import { BotSentMessageRegistry } from 'src/channels/whatsapp/baileys/BotSentMessageRegistry';
import { normalizeWhatsAppAddress } from '../utils/whatsapp-address.util';
import { isLidAddress, phoneToJid } from '../utils/jid.util';
import { WhatsAppContactService } from '../contacts/WhatsAppContactService';
import { SentMessageStore } from './SentMessageStore';

@Injectable()
export class BaileysPlugin implements IChannelPlugin {
  readonly channel = 'WHATSAPP';
  readonly providerName = 'baileys';

  private readonly logger = new Logger(BaileysPlugin.name);

  constructor(
    private readonly limiters: BaileysRateLimiterRegistry,
    private readonly session: BaileysSessionManager,
    private readonly botSentRegistry: BotSentMessageRegistry,
    private readonly contacts: WhatsAppContactService,
    private readonly sentMessages: SentMessageStore,
  ) {}

  validateRecipient(address: string): boolean {
    return normalizeWhatsAppAddress(address) !== null;
  }

  async send(payload: ChannelSendPayload): Promise<ChannelSendResult> {
    const { connectionId } = payload;
    const isConversation = payload.priority === 'conversation';

    if (!connectionId) {
      return this.fail(
        'MISSING_CONNECTION_ID',
        'No se especificó connectionId para el envío por WhatsApp.',
        false,
      );
    }

    if (!this.session.isConnected(connectionId)) {
      return this.notConnected();
    }

    // Una dirección LID (cliente cuyo teléfono WhatsApp no reveló) solo es
    // válida para responderle: el negocio no puede iniciar con un LID.
    const to =
      isConversation && isLidAddress(payload.to)
        ? payload.to
        : normalizeWhatsAppAddress(payload.to);
    if (!to) {
      return this.fail(
        'INVALID_RECIPIENT',
        `Número inválido: ${payload.to}`,
        false,
      );
    }

    if (!isConversation) {
      const gate = await this.contacts.campaignGate(connectionId, to);
      if (!gate.allowed) {
        return this.fail(
          'RECIPIENT_NOT_OPTED_IN',
          `${gate.reason}. Por política anti-bloqueo, el negocio solo inicia mensajes con quien le escribió antes.`,
          false,
        );
      }
    }

    let limiter = this.limiters.get(connectionId);
    if (!limiter) {
      this.logger.warn(
        `Rate limiter ausente para conexión conectada ${connectionId}. Creando con nivel NORMAL por defecto.`,
      );
      limiter = this.limiters.getOrCreate(connectionId, WarmupLevel.NORMAL);
    }

    return limiter.enqueue(
      () => this.sendFlow(connectionId, { ...payload, to }, isConversation),
      {
        priority: isConversation
          ? JobPriority.CONVERSATION
          : JobPriority.CAMPAIGN,
      },
    );
  }

  /**
   * Se ejecuta cuando el rate limiter le da turno, que puede ser minutos u
   * horas después de encolar: el socket se obtiene aquí, no al encolar, para
   * no escribir sobre uno que ya se cerró por una reconexión.
   */
  private async sendFlow(
    connectionId: string,
    payload: ChannelSendPayload,
    isConversation: boolean,
  ): Promise<ChannelSendResult> {
    const sock = this.session.get(connectionId);
    if (!sock || !this.session.isConnected(connectionId)) {
      return this.notConnected();
    }

    // Quien escribió ya existe en WhatsApp: no hace falta consultar.
    if (!isConversation && !isLidAddress(payload.to)) {
      const hasWhatsApp = await this.checkWhatsAppAccount(
        sock,
        connectionId,
        payload.to,
      );
      if (!hasWhatsApp) {
        return this.fail(
          'NO_WHATSAPP_ACCOUNT',
          `El número ${payload.to} no tiene una cuenta de WhatsApp asociada.`,
          false,
        );
      }
    }

    return this.sendMessage(sock, payload);
  }

  private async sendMessage(
    sock: WASocket,
    payload: ChannelSendPayload,
  ): Promise<ChannelSendResult> {
    try {
      const jid = isLidAddress(payload.to)
        ? payload.to
        : phoneToJid(payload.to);
      const text = this.addInvisibleVariation(this.stripHtml(payload.content));

      await sock.sendPresenceUpdate('composing', jid);
      const typingMs =
        Math.min(text.length * 40, 4000) + this.randomInt(500, 1500);

      await this.sleep(typingMs);
      await sock.sendPresenceUpdate('paused', jid);

      const response = await sock.sendMessage(jid, { text });

      if (response?.key?.id) {
        this.botSentRegistry.register(response.key.id);
        this.sentMessages.remember(response.key.id, response.message);
      }

      return {
        success: true,
        provider: this.providerName,
        providerMessageId: response?.key?.id ?? undefined,
        raw: response,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isConnectionError = /connection|closed|timed out|socket/i.test(
        message,
      );
      this.logger.error(`Send error: ${message}`);

      return {
        success: false,
        provider: this.providerName,
        retryable: isConnectionError,
        errorCode: isConnectionError ? 'CONNECTION_ERROR' : 'SEND_FAILED',
        error: message,
        raw: error,
      };
    }
  }

  /**
   * Consultar `onWhatsApp` antes de cada envío es un patrón de enumeración
   * de contactos que WhatsApp vigila: el resultado se cachea por número.
   * Si la consulta falla se asume que existe (el envío dirá si no).
   */
  private async checkWhatsAppAccount(
    sock: WASocket,
    connectionId: string,
    phone: string,
  ): Promise<boolean> {
    const cached = await this.contacts
      .cachedExistence(connectionId, phone)
      .catch(() => null);
    if (cached !== null) return cached;

    try {
      const waResult = await sock.onWhatsApp(phone);
      const exists = waResult?.[0]?.exists ?? false;
      await this.contacts
        .saveExistence(connectionId, phone, exists)
        .catch(() => {});
      return exists;
    } catch {
      return true;
    }
  }

  private notConnected(): ChannelSendResult {
    return this.fail(
      'WHATSAPP_NOT_CONNECTED',
      'WhatsApp no está conectado. Escanea el QR para reconectar.',
      true,
    );
  }

  private randomInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private addInvisibleVariation(text: string): string {
    const invisibleChars = ['​', '‌', '‍', '﻿'];
    const lastChar = text.at(-1) ?? '';
    if (invisibleChars.includes(lastChar)) return text;

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

  private fail(
    errorCode: string,
    error: string,
    retryable: boolean,
  ): ChannelSendResult {
    return {
      success: false,
      provider: this.providerName,
      retryable,
      errorCode,
      error,
      raw: null,
    };
  }
}
