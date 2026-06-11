import { Injectable, Logger } from '@nestjs/common';
import { BotConfigService } from '../config/BotConfigService';
import { ConversationService } from '../conversation/ConversationService';
import { BaileysPlugin } from 'src/channels/whatsapp/baileys/BaileysPlugin';
import { WAMessage } from '@whiskeysockets/baileys';
import { BotStatus } from '@prisma/client';
import { EventBusService } from 'src/infra/events/event.service';
import { EVENT_TYPES } from 'src/infra/events/constants/event.types';

export interface IncomingMessageDto {
  phoneNumber: string;
  content: string;
  hasImage: boolean;
  imageUrl?: string;
}

@Injectable()
export class BotRouter {
  private readonly logger = new Logger(BotRouter.name);

  constructor(
    private readonly botConfigService: BotConfigService,
    private readonly conversationService: ConversationService,
    private readonly eventBus: EventBusService,
  ) {}

  async route(messages: WAMessage[]): Promise<void> {
    for (const message of messages) {
      await this.handleMessage(message).catch((err) => {
        this.logger.error(
          `Error procesando mensaje ${message.key.id}: ${err.message}`,
        );
      });
    }
  }

  private async handleMessage(message: WAMessage): Promise<void> {
    if (message.key.fromMe) return;

    const jid = message.key.remoteJid;
    if (!jid) return;

    if (jid.endsWith('@g.us')) return;

    const phoneNumber = jid.replace('@s.whatsapp.net', '');

    const botConfig = await this.botConfigService.getActiveConfig();

    if (!botConfig || botConfig.status !== BotStatus.ACTIVE) {
      this.logger.debug(`Sin bot activo. Ignorando mensaje de ${phoneNumber}`);
      return;
    }

    const { text, hasImage, imageBuffer } = this.extractContent(message);

    if (!text && !hasImage) {
      this.logger.debug(`Mensaje vacío de ${phoneNumber}. Ignorando.`);
      return;
    }

    const conversation = await this.conversationService.getOrCreate({
      botConfigId: botConfig.id,
      phoneNumber,
      tenantId: botConfig.tenantId,
    });

    const locked = await this.conversationService.acquireLock(conversation.id);

    if (!locked) {
      this.logger.warn(
        `Conversación ${conversation.id} bloqueada. Descartando mensaje de ${phoneNumber}.`,
      );
      return;
    }

    try {
      await this.conversationService.saveInbound(
        conversation.id,
        text ?? '[imagen]',
        hasImage,
      );

      const aiData = await this.conversationService.getConversationForAI(
        conversation.id,
        botConfig.maxHistoryMessages,
      );

      this.publishResponseRequest(
        conversation.id,
        botConfig.id,
        text ?? '',
        hasImage,
      );

      // aqui ira la el service de ia por ahora responde con un massage placeholder
      const responseText = this.buildPlaceholderResponse(
        text,
        hasImage,
        aiData.currentStep,
      );

      await this.conversationService.saveOutbound(
        conversation.id,
        responseText,
      );
    } finally {
      await this.conversationService.releaseLock(conversation.id);
    }
  }

  private extractContent(message: WAMessage): {
    text: string | null;
    hasImage: boolean;
    imageBuffer: Buffer | null;
  } {
    const msg = message.message;

    if (!msg) return { text: null, hasImage: false, imageBuffer: null };

    if (msg.conversation) {
      return { text: msg.conversation, hasImage: false, imageBuffer: null };
    }

    if (msg.extendedTextMessage?.text) {
      return {
        text: msg.extendedTextMessage.text,
        hasImage: false,
        imageBuffer: null,
      };
    }

    if (msg.imageMessage) {
      return {
        text: msg.imageMessage.caption ?? null,
        hasImage: true,
        imageBuffer: null,
      };
    }

    if (msg.documentMessage) {
      return {
        text: msg.documentMessage.caption ?? '[documento]',
        hasImage: false,
        imageBuffer: null,
      };
    }

    //futura integracion de entendimiento de ia a auido
    if (msg.audioMessage) {
      return { text: '[audio]', hasImage: false, imageBuffer: null };
    }

    return { text: null, hasImage: false, imageBuffer: null };
  }

  private publishResponseRequest(
    conversationId: string,
    botConfigId: string,
    text: string,
    hasImage: boolean,
  ) {
    this.eventBus.publish(EVENT_TYPES.BOT_RESPONSE_REQUESTED, {
      conversationId,
      botConfigId,
      userMessage: text,
      hasImage,
    });
  }

  private buildPlaceholderResponse(
    text: string | null,
    hasImage: boolean,
    currentStep: string | null,
  ) {
    if (hasImage) {
      return 'Recibí tu imagen. Estoy analizándola...';
    }
    if (text) {
      return `Recibí tu mensaje: "${text}". El bot con IA estará disponible pronto.`;
    }

    return 'Hola, ¿en qué te puedo ayudar?';
  }
}
