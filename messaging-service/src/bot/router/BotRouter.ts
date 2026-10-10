import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { BotConfigService } from '../config/BotConfigService';
import { ConversationService } from '../conversation/ConversationService';
import { downloadMediaMessage, WAMessage } from '@whiskeysockets/baileys';
import { BotStatus } from '@prisma/client';
import { EventBusService } from 'src/infra/events/event.service';
import { EVENT_TYPES } from 'src/infra/events/constants/event.types';
import { AiOrchestrator } from '../ai/AiOrchestrator';
import { ImageAnalysisService } from '../ai/ImageAnalysisService';
import { BaileysSessionManager } from 'src/channels/whatsapp/baileys/BaileysSessionManager';
import { messageReceiptTracker } from 'src/channels/whatsapp/baileys/MessageReceiptTracker';
import { MessageDebouncer } from './MessageDebouncer';
import { PromptEngine } from '../prompt/PromptEngine';
import { ToolDefinitionService } from '../tools/ToolDefinitionService';
import {
  ToolExecutorService,
  AttachedImage,
} from '../tools/ToolExecutor.service';
import { BotEscalationService } from '../tools/BotEscalation.service';
import { ConversationSummarizer } from '../conversation/ConversationSummarizer';
import { isIgnorableAcknowledgement } from './acknowledgement';
import {
  conversationAddress,
  isIgnorableJid,
  isLidAddress,
} from 'src/channels/whatsapp/utils/jid.util';

interface TurnContext {
  tenantId: string;
  sessionKey: string;
  phoneNumber: string;
  botConfig: any;
  connectionId: string;
  conversationId: string;
}

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
  /** Conversaciones que recibieron mensajes mientras se procesaban. */
  private readonly rerunRequested = new Set<string>();
  /** Último mensaje con imagen por conversación, para analizarla o adjuntarla. */
  private readonly lastImageMessage = new Map<string, WAMessage>();
  private readonly TYPING_RETRY_MS = 6000;
  private readonly AI_FALLBACK_COOLDOWN_MS = 30 * 60 * 1000;
  private readonly MAX_REPLIES_PER_CONTACT_HOUR = 30;

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
    private readonly toolDefinitionService: ToolDefinitionService,
    private readonly toolExecutorService: ToolExecutorService,
    private readonly botEscalation: BotEscalationService,
    private readonly summarizer: ConversationSummarizer,
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
    if (!jid || isIgnorableJid(jid)) return;

    const messageId = message.key.id;
    if (!messageId) return;

    // Teléfono si se conoce; si WhatsApp solo dio un LID, "<lid>@lid".
    const phoneNumber = conversationAddress(jid);
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

    if (text && !hasImage && text.length <= 40) {
      const lastBotMessage = await this.conversationService.lastOutboundContent(
        botConfig.id,
        phoneNumber,
      );
      if (
        isIgnorableAcknowledgement(
          text,
          lastBotMessage,
          this.debouncer.hasPending(sessionKey),
        )
      ) {
        this.logger.debug(
          `Acuse de recibo de ${phoneNumber}: "${text}" (sin pregunta abierta). Marcando leído.`,
        );
        await this.markAsRead(message, connectionId);
        return;
      }
    }

    const delaySeconds = (botConfig.botResponseDelaySeconds ?? 15) * 1000;

    this.debouncer.debounce(
      sessionKey,
      text,
      hasImage,
      delaySeconds,
      async (texts, chatHasImage) => {
        await this.processAccumulatedMessages(
          tenantId,
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

  /**
   * Cierre del debounce: guarda lo que escribió el cliente y responde.
   * El mensaje se persiste antes de cualquier otra decisión (dueño activo,
   * cliente escribiendo, conversación ocupada) para que nunca se pierda: si
   * el bot no responde ahora, lo verá como pendiente en la siguiente pasada.
   */
  private async processAccumulatedMessages(
    tenantId: string,
    sessionKey: string,
    phoneNumber: string,
    texts: string[],
    hasImage: boolean,
    lastMessage: WAMessage,
    botConfig: any,
    connectionId: string,
  ): Promise<void> {
    const conversation = await this.conversationService.getOrCreate({
      botConfigId: botConfig.id,
      phoneNumber,
      tenantId: botConfig.tenantId,
      connectionId,
    });

    const combinedText = texts.join('\n');
    if (combinedText || hasImage) {
      await this.conversationService.saveInbound(
        conversation.id,
        combinedText || '[imagen]',
        hasImage,
        connectionId,
      );
      if (hasImage) this.lastImageMessage.set(conversation.id, lastMessage);
    }

    await this.respond({
      tenantId,
      sessionKey,
      phoneNumber,
      botConfig,
      connectionId,
      conversationId: conversation.id,
    });
  }

  /**
   * Reanuda el bot en una conversación (desde el panel) y responde lo que
   * el cliente haya escrito mientras estuvo en pausa.
   */
  async resumeConversation(
    conversationId: string,
    tenantId: string,
  ): Promise<void> {
    const conversation =
      await this.conversationService.findById(conversationId);
    await this.conversationService.resumeBot(conversationId);

    if (!conversation.lastConnectionId) return;
    const botConfig = await this.botConfigService.getConfigForRouting(
      conversation.botConfigId,
      tenantId,
    );
    if (!botConfig || botConfig.status !== BotStatus.ACTIVE) return;

    const jid = isLidAddress(conversation.phoneNumber)
      ? conversation.phoneNumber
      : `${conversation.phoneNumber}@s.whatsapp.net`;

    void this.respond({
      tenantId,
      sessionKey: this.composeSessionKey(conversation.lastConnectionId, jid),
      phoneNumber: conversation.phoneNumber,
      botConfig,
      connectionId: conversation.lastConnectionId,
      conversationId,
    });
  }

  /**
   * Un solo turno de IA a la vez por conversación. Si llegan mensajes
   * mientras se procesa, se marca una nueva pasada en vez de descartarlos;
   * al terminar, el bot responde lo que quedó pendiente.
   */
  private async respond(turn: TurnContext): Promise<void> {
    const id = turn.conversationId;

    if (this.processingConversations.has(id)) {
      this.rerunRequested.add(id);
      this.logger.debug(
        `Conversación ${id} en proceso: se responderá lo nuevo al terminar.`,
      );
      return;
    }

    this.processingConversations.add(id);
    try {
      const locked = await this.conversationService.acquireLock(id);
      if (!locked) {
        this.logger.warn(
          `Conversación ${id} bloqueada por otro proceso; se reintenta en breve.`,
        );
        this.scheduleRetry(turn, 10_000);
        return;
      }

      try {
        do {
          this.rerunRequested.delete(id);
          await this.answerPending(turn);
        } while (this.rerunRequested.has(id));
      } finally {
        await this.conversationService.releaseLock(id);
      }
    } finally {
      this.processingConversations.delete(id);
    }
  }

  /**
   * Vuelve a intentar responder más tarde. Si ya hay un lote del cliente en
   * espera, ese lote disparará la respuesta y no hace falta programar nada
   * (reemplazar su callback perdería los textos acumulados).
   */
  private scheduleRetry(turn: TurnContext, delayMs: number): void {
    if (this.debouncer.hasPending(turn.sessionKey)) return;
    this.debouncer.debounce(turn.sessionKey, null, false, delayMs, () =>
      this.respond(turn),
    );
  }

  private async answerPending(turn: TurnContext): Promise<void> {
    const { tenantId, sessionKey, phoneNumber, botConfig, connectionId } = turn;
    const conversationId = turn.conversationId;

    if (
      this.receiptTracker.isChatActive(
        sessionKey,
        (botConfig.botResponseDelaySeconds + 5) * 1000,
      )
    ) {
      this.logger.log(
        `Dueño activo en ${sessionKey}. El bot no responde; los mensajes quedan guardados.`,
      );
      return;
    }

    const humanActive = await this.isHumanActive(
      botConfig.id,
      phoneNumber,
      botConfig.humanTakeoverMinutes ?? 10,
    );
    if (humanActive) {
      this.logger.log(`Takeover humano para ${phoneNumber}. Bot en pausa.`);
      return;
    }

    if (this.receiptTracker.isTyping(sessionKey)) {
      this.logger.debug(
        `Cliente escribiendo en ${sessionKey}: se espera a que termine.`,
      );
      this.scheduleRetry(turn, this.TYPING_RETRY_MS);
      return;
    }

    const aiData = await this.conversationService.getConversationForAI(
      conversationId,
      botConfig.maxHistoryMessages,
    );
    if (aiData.pending.length === 0) return;

    if (this.conversationService.isBotPaused(aiData.context)) {
      this.logger.debug(
        `Bot en pausa en ${conversationId} (${String(aiData.context.botPauseReason ?? 'sin motivo')}); los mensajes quedan para el equipo.`,
      );
      return;
    }

    if (await this.exceedsReplyBudget(turn, aiData.context)) return;

    if (!botConfig.aiModels || botConfig.aiModels.length === 0) {
      this.logger.error(
        `El bot "${botConfig.name}" (${botConfig.id}) está ACTIVE pero no tiene ` +
          `ningún modelo de IA activo configurado. Agrega al menos un AiModelConfig ` +
          `con role CONVERSATION desde el panel.`,
      );
      await this.handleAiUnavailable(
        turn,
        aiData.context,
        'Sin modelos de IA configurados',
      );
      return;
    }

    const turnId = aiData.pending[aiData.pending.length - 1].id;

    const combinedText = aiData.pending
      .map((m) => m.content)
      .filter((c) => c !== '[imagen]')
      .join('\n');
    const hasImage = aiData.pending.some((m) => m.hasImage);
    const imageMessage = this.lastImageMessage.get(conversationId);

    let userMessageForAI = combinedText || '[imagen recibida]';
    let imageVerified: boolean | undefined;

    if (hasImage && imageMessage && botConfig.imageAnalysisEnabled) {
      const analysisResult = await this.imageAnalysisService.analyzeFromMessage(
        imageMessage,
        botConfig.id,
        botConfig.systemPrompt,
      );

      if (analysisResult.status === 'SUCCESS') {
        imageVerified = analysisResult.valid;

        await this.conversationService.updateContext(conversationId, {
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

        await this.sendReply(
          turn,
          'No pude analizar tu imagen en este momento por alta demanda. Por favor intenta enviarla de nuevo en unos minutos. 🙏',
          0,
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
      this.logger.debug(`Cliente escribiendo antes de llamar a la IA.`);
      this.scheduleRetry(turn, this.TYPING_RETRY_MS);
      return;
    }

    this.publishResponseRequest(
      conversationId,
      botConfig.id,
      combinedText,
      hasImage,
    );

    const tools = await this.toolDefinitionService.getActiveToolsForBot(
      botConfig.id,
    );
    const toolByName = new Map(tools.map((t) => [t.spec.name, t]));

    const builtPrompt = await this.promptEngine.buildConversationPrompt(
      botConfig.id,
      {
        userMessage: userMessageForAI,
        history: aiData.history,
        context: aiData.context,
        summary: aiData.summary,
        leadingBotMessages: aiData.leadingBotMessages,
        hasImage,
        hasTools: tools.length > 0,
      },
    );

    const toolExecutorFn = tools.length
      ? async (req: { name: string; arguments: Record<string, unknown> }) => {
          const resolved = toolByName.get(req.name);
          if (!resolved) {
            return {
              ok: false,
              content: { error: true, message: 'Tool desconocida.' },
            };
          }

          let attachedImage: AttachedImage | undefined;

          if (resolved.requiresImageAttachment) {
            if (!hasImage || !imageMessage) {
              return {
                ok: false,
                content: {
                  error: true,
                  status: 'MISSING_ATTACHMENT',
                  message:
                    'El cliente no ha enviado ninguna imagen en este mensaje.',
                },
              };
            }

            try {
              const buffer = (await downloadMediaMessage(
                imageMessage,
                'buffer',
                {},
              )) as Buffer;

              attachedImage = {
                dataUri: `data:image/jpeg;base64,${buffer.toString('base64')}`,
                mimeType: 'image/jpeg',
                sizeBytes: buffer.length,
              };
            } catch (err) {
              this.logger.error(
                `Error descargando imagen para tool "${req.name}": ${err.message}`,
              );
              return {
                ok: false,
                content: {
                  error: true,
                  status: 'IMAGE_DOWNLOAD_FAILED',
                  message:
                    'No fue posible descargar la imagen enviada por el cliente.',
                },
              };
            }
          }

          const outcome = await this.toolExecutorService.execute({
            toolDefinitionId: resolved.definitionId,
            conversationId,
            params: req.arguments,
            attachedImage,
            imageParamName: resolved.imageParamName ?? undefined,
            maxImageSizeBytes: resolved.maxImageSizeBytes ?? undefined,
            // Un LID no es un teléfono: no se inyecta para que el backend no
            // busque ni cree un cliente con un número falso.
            injectedPhone:
              resolved.injectPhoneParamName && !isLidAddress(phoneNumber)
                ? phoneNumber
                : undefined,
            phoneParamName: resolved.injectPhoneParamName ?? undefined,
            contactAddress: phoneNumber,
            turnId,
          });

          await this.rememberAction(conversationId, req, outcome);

          if (outcome.status === 'SUCCESS' && resolved.pausesBotMinutes) {
            // Traspaso a una persona: el bot deja de responder en este chat
            // (esta última respuesta sí sale, para avisarle al cliente).
            const until = await this.conversationService.pauseBot(
              conversationId,
              resolved.pausesBotMinutes,
              `Traspaso a una persona (${req.name})`,
            );
            this.logger.log(
              `Bot pausado en ${conversationId} hasta ${until.toISOString()} por "${req.name}".`,
            );
          }

          if (outcome.status === 'TECHNICAL_ERROR') {
            await this.botEscalation.notifyToolFailure(
              tenantId,
              botConfig.id,
              outcome.status,
              req.name,
              phoneNumber,
              outcome.errorDetail,
            );
          }

          return {
            ok: outcome.status === 'SUCCESS',
            content: {
              status: outcome.status,
              data: outcome.responseBody,
              error: outcome.status !== 'SUCCESS',
              errorDetail: outcome.errorDetail,
            },
          };
        }
      : undefined;

    let aiResult: Awaited<ReturnType<AiOrchestrator['generateResponse']>>;
    try {
      aiResult = await this.aiOrchestrator.generateResponse({
        botConfigId: botConfig.id,
        systemPrompt: builtPrompt.systemPrompt,
        userMessage: userMessageForAI,
        history: aiData.history,
        context: aiData.context,
        summary: aiData.summary,
        maxTokens: builtPrompt.maxTokens,
        temperature: builtPrompt.temperature,
        tools: tools.length ? tools.map((t) => t.spec) : undefined,
        toolExecutor: toolExecutorFn,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`IA no disponible para ${phoneNumber}: ${detail}`);
      await this.handleAiUnavailable(turn, aiData.context, detail);
      return;
    }

    const finalContent = this.applyToolFailureDiscipline(aiResult, phoneNumber);

    if (this.receiptTracker.isChatActive(sessionKey, 30000)) {
      this.logger.log(
        `Dueño activo mientras IA procesaba. Respuesta descartada.`,
      );
      return;
    }

    const lastOutbound = aiData.history
      .filter((h) => h.role === 'assistant')
      .at(-1);

    let reply = finalContent;
    let tokensUsed = aiResult.tokensUsed;

    if (lastOutbound && this.isTooSimilar(reply, lastOutbound.content)) {
      this.logger.warn(
        `Respuesta duplicada detectada para ${phoneNumber}. Se genera otra.`,
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

        reply = this.applyToolFailureDiscipline(retryResult, phoneNumber);
        tokensUsed = retryResult.tokensUsed;
      } catch (retryErr) {
        this.logger.error(
          `Error en reintento de respuesta: ${retryErr.message}`,
        );
        return;
      }
    }

    // Se espera el envío dentro del lock: la respuesta queda guardada antes
    // de la siguiente pasada, así lo ya respondido no vuelve a verse como
    // pendiente (evita contestar dos veces lo mismo).
    await this.sendReply(turn, reply, tokensUsed, imageVerified);
    if (hasImage) this.lastImageMessage.delete(conversationId);

    void this.summarizer.refreshIfNeeded(
      conversationId,
      botConfig.id,
      botConfig.maxHistoryMessages,
    );
  }

  /**
   * La IA no respondió (sin saldo, proveedor caído, sin modelos): el cliente
   * recibe un aviso honesto en vez de silencio y el equipo es notificado.
   * Como mucho un aviso cada 30 min por conversación; mientras tanto los
   * mensajes quedan guardados para el equipo o para cuando la IA vuelva.
   */
  private async handleAiUnavailable(
    turn: TurnContext,
    context: Record<string, unknown>,
    detail: string,
  ): Promise<void> {
    const last =
      typeof context.aiFallbackAt === 'string'
        ? new Date(context.aiFallbackAt).getTime()
        : 0;
    if (Date.now() - last < this.AI_FALLBACK_COOLDOWN_MS) return;

    await this.conversationService.updateContext(turn.conversationId, {
      contextPatch: { aiFallbackAt: new Date().toISOString() },
    });
    await this.sendReply(
      turn,
      '¡Hola! Recibimos tu mensaje 🙌 En este momento nuestro asistente no está disponible; ' +
        'una persona del equipo te responderá lo antes posible por este mismo chat.',
      0,
    );
    await this.botEscalation.notifyToolFailure(
      turn.tenantId,
      turn.botConfig.id,
      'TECHNICAL_ERROR',
      'asistente de IA',
      turn.phoneNumber,
      detail,
    );
  }

  /**
   * Freno ante un chat desbocado (spam, un bot del otro lado, alguien
   * probando el sistema): protege el número de un volumen anómalo y el
   * costo de IA. Al superar el tope, un aviso, pausa de 1 h y alerta.
   */
  private async exceedsReplyBudget(
    turn: TurnContext,
    context: Record<string, unknown>,
  ): Promise<boolean> {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const replies = await this.conversationService.countBotRepliesSince(
      turn.conversationId,
      since,
    );
    if (replies < this.MAX_REPLIES_PER_CONTACT_HOUR) return false;

    const noticed =
      typeof context.abuseNoticeAt === 'string' &&
      new Date(context.abuseNoticeAt).getTime() > since.getTime();
    if (noticed) return true;

    this.logger.warn(
      `Tope de ${this.MAX_REPLIES_PER_CONTACT_HOUR} respuestas/hora alcanzado con ${turn.phoneNumber}: bot en pausa 1 h.`,
    );
    await this.conversationService.updateContext(turn.conversationId, {
      contextPatch: { abuseNoticeAt: new Date().toISOString() },
    });
    await this.sendReply(
      turn,
      'Hemos recibido muchos mensajes seguidos. Para atenderte mejor, una persona del equipo continuará la conversación en breve. 🙏',
      0,
    );
    await this.conversationService.pauseBot(
      turn.conversationId,
      60,
      'Tope de mensajes por hora',
    );
    await this.botEscalation.notifyToolFailure(
      turn.tenantId,
      turn.botConfig.id,
      'TECHNICAL_ERROR',
      'tope de mensajes por cliente',
      turn.phoneNumber,
      `${replies} respuestas en la última hora`,
    );
    return true;
  }

  private async sendReply(
    turn: TurnContext,
    content: string,
    tokensUsed: number,
    imageVerified?: boolean,
  ): Promise<void> {
    await this.eventBus.publishAsync(EVENT_TYPES.CHANNEL_SEND_REQUESTED, {
      phoneNumber: turn.phoneNumber,
      content,
      conversationId: turn.conversationId,
      connectionId: turn.connectionId,
      tokensUsed,
      imageVerified,
    });
  }

  /** Guarda el resultado real de una herramienta en la memoria de la conversación. */
  private async rememberAction(
    conversationId: string,
    req: { name: string; arguments: Record<string, unknown> },
    outcome: {
      status: string;
      responseBody: unknown;
      errorDetail: string | null;
    },
  ): Promise<void> {
    try {
      await this.conversationService.appendActionMemory(conversationId, {
        herramienta: req.name,
        parametros: this.compactJson(req.arguments, 200),
        estado: outcome.status,
        resultado:
          outcome.status === 'SUCCESS'
            ? this.compactJson(outcome.responseBody, 600)
            : (outcome.errorDetail ??
              this.compactJson(outcome.responseBody, 300)),
        en: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.warn(
        `No fue posible guardar la memoria de la acción "${req.name}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private compactJson(value: unknown, maxChars: number): string {
    let text: string;
    try {
      text = JSON.stringify(value, (_key, v: unknown) =>
        typeof v === 'string' && v.startsWith('data:') ? '[archivo]' : v,
      );
    } catch {
      text = String(value);
    }
    text = text ?? '';
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
  }

  private applyToolFailureDiscipline(
    result: { content: string; toolCallsExecuted?: Array<{ ok: boolean }> },
    phoneNumber: string,
  ): string {
    const hasFailedToolCall = result.toolCallsExecuted?.some((t) => !t.ok);

    if (!hasFailedToolCall) return result.content;

    this.logger.warn(
      `Tool call fallida detectada en la respuesta para ${phoneNumber} — se ` +
        `sustituye el mensaje generado por uno honesto, sin importar el ` +
        `contenido que el modelo haya producido.`,
    );

    return (
      'Tuvimos un inconveniente al procesar tu solicitud. Una persona de ' +
      'nuestro equipo se pondrá en contacto contigo en breve para ayudarte. 🙏'
    );
  }

  async registerHumanMessage(
    message: WAMessage,
    botConfigId: string,
    connectionId: string,
    tenantId: string,
  ): Promise<void> {
    const jid = message.key.remoteJidAlt ?? message.key.remoteJid;
    if (!jid || isIgnorableJid(jid)) return;

    const sessionKey = this.composeSessionKey(connectionId, jid);
    this.debouncer.cancel(sessionKey);

    this.logger.debug(`Debounce cancelado por mensaje humano en ${sessionKey}`);

    const phoneNumber = conversationAddress(jid);
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

  private isTooSimilar(a: string, b: string): boolean {
    const normalize = (s: string) =>
      s.toLowerCase().replace(/\s+/g, ' ').trim();
    const na = normalize(a);
    const nb = normalize(b);

    if (na === nb) return true;

    if (na.includes(nb) || nb.includes(na)) return true;

    return false;
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
