import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { BotConfigService } from '../config/BotConfigService';
import { ConversationService } from '../conversation/ConversationService';
import { WAMessage } from '@whiskeysockets/baileys';
import { BotStatus } from '@prisma/client';
import { EventBusService } from 'src/infra/events/event.service';
import { EVENT_TYPES } from 'src/infra/events/constants/event.types';
import { AiOrchestrator } from '../ai/AiOrchestrator';
import { ImageAnalysisService } from '../ai/ImageAnalysisService';
import { BaileysSessionManager } from 'src/channels/whatsapp/baileys/BaileysSessionManager';
import { messageReceiptTracker } from 'src/channels/whatsapp/baileys/MessageReceiptTracker';
import { MessageDebouncer } from './MessageDebouncer';
import { PromptEngine } from '../prompt/PromptEngine';

export interface IncomingMessageDto {
  phoneNumber: string;
  content: string;
  hasImage: boolean;
  imageUrl?: string;
}

@Injectable()
export class BotRouter {
  private readonly logger = new Logger(BotRouter.name);

  private readonly processingConversations = new Set<string>();

  constructor(
    @Inject(forwardRef(() => BaileysSessionManager))
    private readonly sessionManager: BaileysSessionManager,

    private readonly botConfigService: BotConfigService,
    private readonly conversationService: ConversationService,
    private readonly eventBus: EventBusService,
    private readonly aiOrchestrator: AiOrchestrator,
    private readonly imageAnalysisService: ImageAnalysisService,
    private readonly receiptTracker: messageReceiptTracker,
    private readonly debouncer: MessageDebouncer,
    private readonly promptEngine: PromptEngine,
  ) {}

  async route(
    messages: WAMessage[],
    botConfigId: string,
    connectionId: string,
    tenantId: string,
  ): Promise<void> {
    for (const message of messages) {
      await this.handleMessage(
        message,
        botConfigId,
        connectionId,
        tenantId,
      ).catch((err) => {
        this.logger.error(
          `Error procesando mensaje ${message.key.id}: ${err.message}`,
        );
      });
    }
  }

  private async handleMessage(
    message: WAMessage,
    botConfigId: string,
    connectionId: string,
    tenantId: string,
  ): Promise<void> {
    if (message.key.fromMe) return;

    const jid = message.key.remoteJidAlt ?? message.key.remoteJid;
    if (!jid) return;
    if (jid.endsWith('@g.us')) return;

    const messageId = message.key.id;
    if (!messageId) return;

    const phoneNumber = jid.replace('@s.whatsapp.net', '').replace('@lid', '');
    const sessionKey = this.composeSessionKey(connectionId, jid);

    const botConfig = await this.botConfigService.getConfigForRouting(
      botConfigId,
      tenantId,
    );

    if (!botConfig) {
      this.logger.error(
        `Inconsistencia de datos: la conexión ${connectionId} (tenant ${tenantId}) ` +
          `apunta a botConfigId ${botConfigId}, que no existe o no pertenece a ` +
          `este tenant. Revisa WhatsAppConnection.botConfigId para esta conexión. ` +
          `Mensaje de ${phoneNumber} ignorado.`,
      );
      return;
    }

    if (botConfig.status !== BotStatus.ACTIVE) {
      const activeBot =
        await this.botConfigService.findActiveForTenant(tenantId);

      if (!activeBot) {
        this.logger.warn(
          `Tenant ${tenantId} no tiene ningún bot registrado como ACTIVE. ` +
            `El bot vinculado a esta conexión ("${botConfig.name}", ${botConfig.id}) ` +
            `está en estado ${botConfig.status}. Actívalo desde el panel para que ` +
            `responda a los mensajes. Mensaje de ${phoneNumber} ignorado.`,
        );
      } else if (activeBot.id === botConfig.id) {
        this.logger.warn(
          `Estado inconsistente detectado para el bot ${botConfig.id}: se ` +
            `reporta como activo en otra consulta pero como "${botConfig.status}" aquí. ` +
            `Posible condición de carrera — reintenta el mensaje.`,
        );
      } else {
        this.logger.warn(
          `El bot vinculado a esta conexión ("${botConfig.name}", ${botConfig.id}) ` +
            `está en estado ${botConfig.status}, no ACTIVE. Este tenant SÍ tiene un ` +
            `bot activo — "${activeBot.name}" (${activeBot.id}) — pero no está ` +
            `vinculado a esta conexión (${connectionId}). Verifica ` +
            `WhatsAppConnection.botConfigId o activa "${botConfig.name}" si es el ` +
            `bot correcto para esta conexión. Mensaje de ${phoneNumber} ignorado.`,
        );
      }
      return;
    }

    const messageTimestap = Number(message.messageTimestamp ?? 0) * 1000;
    const messageAgeMs = Date.now() - messageTimestap;
    const MaxAgeMs = (botConfig.maxMessageAgeMinutes ?? 1440) * 60 * 1000;

    if (messageAgeMs > MaxAgeMs) {
      this.logger.debug(
        `Mensage de ${phoneNumber} igonrado: anguedad ${Math.round(messageAgeMs / 60000)} min > limite ${botConfig.maxMessageAgeMinutes} min`,
      );

      await this.markAsRead(message, connectionId);
      return;
    }

    if (this.receiptTracker.isChatActive(sessionKey, 60000)) {
      this.logger.debug(
        `Chat ${sessionKey} activo recientemente (dueño presente). Bot no procesa.`,
      );
      this.debouncer.cancel(sessionKey);
      return;
    }

    const { text, hasImage } = this.extractContent(message);

    if (!text && !hasImage) {
      await this.markAsRead(message, connectionId);
      return;
    }

    if (text && this.isTrivialMessage(text)) {
      this.logger.debug(
        `Mensaje trivial de ${phoneNumber}: "${text}". Marcando leído.`,
      );
      await this.markAsRead(message, connectionId);
      return;
    }

    const delaySeconds = (botConfig.botResponseDelaySeconds ?? 15) * 1000;

    this.debouncer.debounce(
      sessionKey,
      text,
      hasImage,
      delaySeconds,
      async (texts, chatHasImage) => {
        await this.processAccumulatedMessages(
          sessionKey,
          phoneNumber,
          texts,
          chatHasImage,
          message,
          botConfig,
          connectionId,
        );
      },
      messageId,
    );
  }

  private async processAccumulatedMessages(
    sessionKey: string,
    phoneNumber: string,
    texts: string[],
    hasImage: boolean,
    lastMessage: WAMessage,
    botConfig: any,
    connectionId: string,
  ): Promise<void> {
    if (
      this.receiptTracker.isChatActive(
        sessionKey,
        (botConfig.botResponseDelaySeconds + 5) * 1000,
      )
    ) {
      this.logger.log(
        `Dueño activo en ${sessionKey} después del delay. Bot cancelado.`,
      );
      return;
    }

    this.logger.debug(`Verificando isChatActive para JID: "${sessionKey}"`);

    if (this.receiptTracker.isTyping(sessionKey)) {
      this.logger.debug(
        `Usuario escribiendo en ${sessionKey}. Esperando 3s más...`,
      );
      await this.sleep(3000);

      if (this.receiptTracker.isTyping(sessionKey)) {
        this.logger.debug(`Usuario sigue escribiendo. Cancelando respuesta.`);
        return;
      }
    }

    this.logger.debug(
      `Chat activo result: ${this.receiptTracker.isChatActive(sessionKey, (botConfig.botResponseDelaySeconds + 5) * 1000)}`,
    );

    const humanActive = await this.isHumanActive(
      botConfig.id,
      phoneNumber,
      botConfig.humanTakeoverMinutes ?? 10,
    );
    if (humanActive) {
      this.logger.log(`Takeover humano para ${phoneNumber}. Bot cancelado.`);
      return;
    }

    const conversation = await this.conversationService.getOrCreate({
      botConfigId: botConfig.id,
      phoneNumber,
      tenantId: botConfig.tenantId,
      connectionId,
    });

    const combinedText = texts.join('\n');

    await this.conversationService.saveInbound(
      conversation.id,
      combinedText || '[imagen]',
      hasImage,
      connectionId,
    );

    if (this.processingConversations.has(conversation.id)) {
      this.logger.warn(
        `Conversación ${conversation.id} ya en proceso (in-memory guard). Descartando.`,
      );
      return;
    }

    this.processingConversations.add(conversation.id);

    const locked = await this.conversationService.acquireLock(conversation.id);
    if (!locked) {
      this.logger.warn(`Conversación ${conversation.id} bloqueada.`);
      return;
    }

    try {
      if (!botConfig.aiModels || botConfig.aiModels.length === 0) {
        this.logger.error(
          `El bot "${botConfig.name}" (${botConfig.id}) está ACTIVE pero no tiene ` +
            `ningún modelo de IA activo configurado. Agrega al menos un AiModelConfig ` +
            `con role CONVERSATION desde el panel. Mensaje de ${phoneNumber} sin responder.`,
        );
        return;
      }

      const aiData = await this.conversationService.getConversationForAI(
        conversation.id,
        botConfig.maxHistoryMessages,
      );

      let userMessageForAI = combinedText || '[imagen recibida]';

      if (hasImage && botConfig.imageAnalysisEnabled) {
        const analysisResult =
          await this.imageAnalysisService.analyzeFromMessage(
            lastMessage,
            botConfig.id,
            botConfig.systemPrompt,
          );

        if (analysisResult.status === 'SUCCESS') {
          await this.conversationService.updateContext(conversation.id, {
            contextPatch: {
              imageVerified: analysisResult.valid,
              lastImageDetails: analysisResult.details?.slice(0, 100),
            },
          });

          const imageCtx = `[imagen: válida=${analysisResult.valid}, confianza=${analysisResult.confidence}${analysisResult.details ? `, ${analysisResult.details.slice(0, 80)}` : ''}]`;
          userMessageForAI = combinedText
            ? `${imageCtx}\n${combinedText}`
            : imageCtx;
        } else if (analysisResult.status === 'PROVIDER_UNAVAILABLE') {
          this.logger.warn(
            `Análisis de imagen no disponible para ${phoneNumber}. Respondiendo con mensaje de espera.`,
          );

          const fallbackMsg =
            'No pude analizar tu imagen en este momento por alta demanda. Por favor intenta enviarla de nuevo en unos minutos. 🙏';

          this.eventBus.publish(EVENT_TYPES.CHANNEL_SEND_REQUESTED, {
            phoneNumber,
            content: fallbackMsg,
            conversationId: conversation.id,
            connectionId,
            tokensUsed: 0,
          });

          await this.conversationService.saveOutbound(
            conversation.id,
            fallbackMsg,
          );
          return;
        } else {
          this.logger.warn(
            `Error de análisis para ${phoneNumber}. Continuando sin contexto de imagen.`,
          );
          userMessageForAI = combinedText
            ? `[imagen recibida, no analizada]\n${combinedText}`
            : '[imagen recibida, no analizada]';
        }
      }

      if (this.receiptTracker.isTyping(sessionKey)) {
        this.logger.debug(
          `Usuario escribiendo antes de llamar IA. Cancelando.`,
        );
        return;
      }

      this.publishResponseRequest(
        conversation.id,
        botConfig.id,
        combinedText,
        hasImage,
      );

      const builtPrompt = await this.promptEngine.buildConversationPrompt(
        botConfig.id,
        {
          userMessage: userMessageForAI,
          history: aiData.history,
          context: aiData.context,
          summary: aiData.summary,
          hasImage: hasImage,
        },
      );

      const aiResult = await this.aiOrchestrator.generateResponse({
        botConfigId: botConfig.id,
        systemPrompt: builtPrompt.systemPrompt,
        userMessage: userMessageForAI,
        history: aiData.history,
        context: aiData.context,
        summary: aiData.summary,
        maxTokens: builtPrompt.maxTokens,
        temperature: builtPrompt.temperature,
      });

      if (this.receiptTracker.isChatActive(sessionKey, 30000)) {
        this.logger.log(
          `Dueño activo mientras IA procesaba. Respuesta descartada.`,
        );
        return;
      }

      const lastOutbound = aiData.history
        .filter((h) => h.role === 'assistant')
        .at(-1);

      if (
        lastOutbound &&
        this.isTooSimilar(aiResult.content, lastOutbound.content)
      ) {
        this.logger.warn(
          `Respuesta duplicada detectada para ${phoneNumber}. Descartando.`,
        );
        try {
          const retryResult = await this.aiOrchestrator.generateResponse({
            botConfigId: botConfig.id,
            systemPrompt: builtPrompt.systemPrompt,
            userMessage: combinedText || userMessageForAI,
            history: [],
            context: aiData.context,
            summary: aiData.summary,
            maxTokens: builtPrompt.maxTokens,
            temperature: Math.min((builtPrompt.temperature ?? 0.7) + 0.3, 1.0),
          });

          if (this.isTooSimilar(retryResult.content, lastOutbound.content)) {
            this.logger.warn(
              `Reintento también similar para ${phoneNumber}. Descartando para evitar spam.`,
            );
            return;
          }

          this.eventBus.publish(EVENT_TYPES.CHANNEL_SEND_REQUESTED, {
            phoneNumber,
            content: retryResult.content,
            conversationId: conversation.id,
            connectionId,
            tokensUsed: retryResult.tokensUsed,
          });

          await this.conversationService.saveOutbound(
            conversation.id,
            retryResult.content,
            {
              tokensUsed: retryResult.tokensUsed,
            },
          );
        } catch (retryErr) {
          this.logger.error(
            `Error en reintento de respuesta: ${retryErr.message}`,
          );
        }

        return;
      }

      this.eventBus.publish(EVENT_TYPES.CHANNEL_SEND_REQUESTED, {
        phoneNumber,
        content: aiResult.content,
        conversationId: conversation.id,
        connectionId,
        tokensUsed: aiResult.tokensUsed,
      });

      await this.conversationService.saveOutbound(
        conversation.id,
        aiResult.content,
        {
          tokensUsed: aiResult.tokensUsed,
        },
      );
    } finally {
      this.processingConversations.delete(conversation.id);
      await this.conversationService.releaseLock(conversation.id);
    }
  }

  async registerHumanMessage(
    message: WAMessage,
    botConfigId: string,
    connectionId: string,
    tenantId: string,
  ): Promise<void> {
    const jid = message.key.remoteJidAlt ?? message.key.remoteJid;
    if (!jid || jid.endsWith('@g.us')) return;

    const sessionKey = this.composeSessionKey(connectionId, jid);
    this.debouncer.cancel(sessionKey);

    this.logger.debug(`Debounce cancelado por mensaje humano en ${sessionKey}`);

    const phoneNumber = jid.replace('@s.whatsapp.net', '').replace('@lid', '');
    const { text } = this.extractContent(message);
    if (!text) return;

    const botConfig = await this.botConfigService.getConfigForRouting(
      botConfigId,
      tenantId,
    );

    if (!botConfig) return;

    const conversation = await this.conversationService.findActiveByPhone(
      botConfig.id,
      phoneNumber,
    );

    if (!conversation) return;

    await this.conversationService.saveHumanOutbound(conversation.id, text);

    this.logger.debug(`Takeover humano registrado para ${phoneNumber}`);
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

  private async isHumanActive(
    botConfigId: string,
    phoneNumber: string,
    takeoverMinutes: number,
  ): Promise<boolean> {
    const cutoff = new Date(Date.now() - takeoverMinutes * 60 * 1000);

    const recenHumanMessage =
      await this.conversationService.findLastHumanMessage(
        botConfigId,
        phoneNumber,
        cutoff,
      );

    return recenHumanMessage !== null;
  }

  private readonly TRIVIAL_PATTERNS = [
    /^(ok|okay|okey|vale|sí|si|no|ya|dale|listo|gracias|thanks|ty|bye|adiós|adios|ciao|chao|hasta luego|ok gracias|👍|🙏|❤️|😊|👋|np|de nada|con gusto)$/i,
  ];

  private isTooSimilar(a: string, b: string): boolean {
    const normalize = (s: string) =>
      s.toLowerCase().replace(/\s+/g, ' ').trim();
    const na = normalize(a);
    const nb = normalize(b);

    if (na === nb) return true;

    if (na.includes(nb) || nb.includes(na)) return true;

    return false;
  }

  private isTrivialMessage(text: string): boolean {
    const normalized = text.trim().toLowerCase();
    return this.TRIVIAL_PATTERNS.some((pattern) => pattern.test(normalized));
  }

  private async markAsRead(
    message: WAMessage,
    connectionId: string,
  ): Promise<void> {
    try {
      const sock = this.sessionManager.get(connectionId);
      if (!sock || !message.key.remoteJid) return;

      await sock.readMessages([message.key]);
    } catch (err) {
      this.logger.debug(`no se puede marcar como leido: ${err.message}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private composeSessionKey(connectionId: string, jid: string): string {
    return `${connectionId}:${jid}`;
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
