import { Injectable, Logger } from '@nestjs/common';
import { BotConfigService } from '../config/BotConfigService';
import { ConversationService } from '../conversation/ConversationService';
import { WAMessage } from '@whiskeysockets/baileys';
import { BotStatus } from '@prisma/client';
import { EventBusService } from 'src/infra/events/event.service';
import { EVENT_TYPES } from 'src/infra/events/constants/event.types';
import { AiOrchestrator } from '../ai/AiOrchestrator';
import { ImageAnalysisService } from '../ai/ImageAnalysisService';

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
    private readonly aiOrchestrator: AiOrchestrator,
    private readonly imageAnalysisService: ImageAnalysisService,
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

    const jid = message.key.remoteJidAlt ?? message.key.remoteJid;
    if (!jid) return;

    console.log('REMOTE JID:', message.key.remoteJid);
    console.log('PARTICIPANT:', message.key.participant);
    console.log('PUSHNAME:', message.pushName);
    console.dir(message, { depth: 4 });

    console.log(JSON.stringify(message, null, 2));

    this.logger.log(`JID recibido: ${jid}`);

    if (jid.endsWith('@g.us')) return;

    const phoneNumber = jid.replace('@s.whatsapp.net', '').replace('@lid', '');

    console.log('DESTINO:', phoneNumber);

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

      let userMessageForAI = text ?? '[imagen recibida]';

      if (hasImage) {
        const analysisResult =
          await this.imageAnalysisService.analyzeFromMessage(
            message,
            botConfig.id,
            botConfig.systemPrompt,
          );

        await this.conversationService.updateContext(conversation.id, {
          contextPatch: {
            lastImageAnalysis: analysisResult,
            imageVerified: analysisResult.valid,
          },
        });

        userMessageForAI = `
Usuario envió una imagen.

Resultado del análisis:
- válida: ${analysisResult.valid}
- confianza: ${analysisResult.confidence}
- detalles: ${analysisResult.details ?? 'Sin detalles'}

Mensaje adjunto:
${text ?? ''}
      `.trim();
      }

      this.publishResponseRequest(
        conversation.id,
        botConfig.id,
        text ?? '',
        hasImage,
      );

      const aiResult = await this.aiOrchestrator.generateResponse({
        botConfigId: botConfig.id,
        systemPrompt: botConfig.systemPrompt,
        userMessage: text ?? '[imagen recibida]',
        history: aiData.history,
        context: aiData.context,
        summary: aiData.summary,
      });

      const responseText = aiResult.content;

      this.eventBus.publish(EVENT_TYPES.CHANNEL_SEND_REQUESTED, {
        phoneNumber,
        content: responseText,
        conversationId: conversation.id,
        tokensUsed: aiResult.tokensUsed,
      });

      await this.conversationService.saveOutbound(
        conversation.id,
        responseText,
        {
          tokensUsed: aiResult.tokensUsed,
        },
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
}
