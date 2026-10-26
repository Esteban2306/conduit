import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { BotConfigService } from '../config/BotConfigService';
import { ConversationService } from '../conversation/ConversationService';
import { downloadMediaMessage, WAMessage } from '@whiskeysockets/baileys';
import { BotStatus, ReasoningMode } from '@prisma/client';
import { EventBusService } from 'src/infra/events/event.service';
import { EVENT_TYPES } from 'src/infra/events/constants/event.types';
import { AiOrchestrator } from '../ai/AiOrchestrator';
import { ImageAnalysisService } from '../ai/ImageAnalysisService';
import { BaileysSessionManager } from 'src/channels/whatsapp/baileys/BaileysSessionManager';
import { messageReceiptTracker } from 'src/channels/whatsapp/baileys/MessageReceiptTracker';
import { MessageDebouncer } from './MessageDebouncer';
import { BuiltPrompt, PromptEngine } from '../prompt/PromptEngine';
import type { SystemBlocks } from '../ai/interface/AiProvider';
import {
  ResolvedTool,
  ToolDefinitionService,
} from '../tools/ToolDefinitionService';
import {
  ToolExecutorService,
  AttachedImage,
} from '../tools/ToolExecutor.service';
import { HandoffService } from '../handoff/Handoff.service';
import { FAILURE_STREAKS_KEY } from '../handoff/handoff-defaults';
import { promisesHumanContact } from '../handoff/handoff-promise';
import { TurnBudget } from '../ai/turn-budget';
import {
  jittered,
  readDelayMs,
} from 'src/channels/whatsapp/baileys/human-timing';
import { IntentHandler } from '../intent/IntentHandler';
import { isTaskDone } from '../intent/intent-turn';
import { AiOutageDigestService } from '../tools/AiOutageDigest.service';
import { BotEscalationService } from '../tools/BotEscalation.service';
import { ConversationSummarizer } from '../conversation/ConversationSummarizer';
import { isIgnorableAcknowledgement } from './acknowledgement';
import {
  conversationAddress,
  isIgnorableJid,
  isLidAddress,
  phoneToJid,
} from 'src/channels/whatsapp/utils/jid.util';
import { chatKey } from 'src/channels/whatsapp/utils/chat-key';
import { maskError, maskSecrets } from 'src/shared/security/mask-secrets';
import {
  EXPIRED_REPLY,
  IGNORED_INBOUND,
} from '../conversation/ConversationService';
import {
  EXPECTED_FAILURES_BEFORE_OFFER,
  FailureStreaks,
  RecordedOutcome,
  classifyOutcome,
  nextStreaks,
  unresolvedFailures,
} from '../tools/tool-outcome';
import { cutAtSentence, isBlank } from './reply-guard';
import { ReplyMetricsService } from './reply-metrics.service';

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
  private readonly RECOVERY_STAGGER_MS = 3000;
  private readonly readGates = new Map<string, Promise<void>>();
  private readonly OWNER_DISCARD_RETRY_MS = 30_000;
  private static readonly TRUNCATED_RETRY_MAX_TOKENS = 2048;

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
    private readonly replyMetrics: ReplyMetricsService,
    private readonly aiOutageDigest: AiOutageDigestService,
    private readonly intentHandler: IntentHandler,
    private readonly handoffService: HandoffService,
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
    const sessionKey = chatKey(connectionId, jid);

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

    const { text, hasImage } = this.extractContent(message);

    if (!text && !hasImage) {
      await this.markAsRead(message, connectionId);
      return;
    }

    const conversation = await this.conversationService.getOrCreate({
      botConfigId: botConfig.id,
      phoneNumber,
      tenantId: botConfig.tenantId,
      connectionId,
    });

    let ignorable = false;
    if (text && !hasImage && text.length <= 40) {
      const lastBotMessage = await this.conversationService.lastOutboundContent(
        botConfig.id,
        phoneNumber,
      );
      ignorable = isIgnorableAcknowledgement(
        text,
        lastBotMessage,
        this.debouncer.hasPending(sessionKey),
        isTaskDone(conversation.context as Record<string, unknown>),
      );
    }

    const saved = await this.conversationService.saveInbound(
      conversation.id,
      text ?? '[imagen]',
      hasImage,
      connectionId,
      {
        waMessageId: messageId,
        processedBy: ignorable ? IGNORED_INBOUND : undefined,
      },
    );
    if (!saved.created) {
      this.logger.debug(
        `Mensaje ${messageId} ya guardado; se ignora el duplicado.`,
      );
      return;
    }

    if (ignorable) {
      this.logger.debug(
        `Acuse de recibo de ${phoneNumber}: "${text}" (sin pregunta abierta). Marcando leído.`,
      );
      await this.markAsRead(message, connectionId);
      return;
    }

    if (hasImage) this.lastImageMessage.set(conversation.id, message);

    const turn: TurnContext = {
      tenantId,
      sessionKey,
      phoneNumber,
      botConfig,
      connectionId,
      conversationId: conversation.id,
    };
    this.debouncer.schedule(
      sessionKey,
      jittered((botConfig.botResponseDelaySeconds ?? 15) * 1000),
      () => this.respond(turn),
    );
  }

  async recoverPending(
    connectionId: string,
    botConfigId: string,
    tenantId: string,
  ): Promise<number> {
    const botConfig = await this.botConfigService.getConfigForRouting(
      botConfigId,
      tenantId,
    );
    if (!botConfig || botConfig.status !== BotStatus.ACTIVE) return 0;

    const since = new Date(
      Date.now() - (botConfig.maxMessageAgeMinutes ?? 1440) * 60_000,
    );
    const conversations =
      await this.conversationService.findConversationsWithPending(
        botConfig.id,
        connectionId,
        since,
      );
    const baseDelay = (botConfig.botResponseDelaySeconds ?? 15) * 1000;

    conversations.forEach((conversation, index) => {
      const jid = isLidAddress(conversation.phoneNumber)
        ? conversation.phoneNumber
        : phoneToJid(conversation.phoneNumber);
      const sessionKey = chatKey(connectionId, jid);
      if (this.debouncer.hasPending(sessionKey)) return;
      this.debouncer.schedule(
        sessionKey,
        baseDelay + index * this.RECOVERY_STAGGER_MS,
        () =>
          this.respond({
            tenantId,
            sessionKey,
            phoneNumber: conversation.phoneNumber,
            botConfig,
            connectionId,
            conversationId: conversation.id,
          }),
      );
    });

    if (conversations.length > 0) {
      this.logger.log(
        `Recuperación en ${connectionId}: ${conversations.length} conversación(es) con mensajes sin responder.`,
      );
    }
    return conversations.length;
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
      sessionKey: chatKey(conversation.lastConnectionId, jid),
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
        this.readGates.delete(id);
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
  /**
   * La clienta tardó más de `minutes` en contestar el último mensaje del bot
   * y esa conversación todavía no se reinició después de él.
   */
  private isIdleSince(
    last: { at: Date } | null,
    minutes: number,
    context: Record<string, unknown>,
  ): boolean {
    if (!last || Date.now() - last.at.getTime() <= minutes * 60_000) {
      return false;
    }
    const closed = context.closedAt;
    return !(
      typeof closed === 'string' &&
      new Date(closed).getTime() >= last.at.getTime()
    );
  }

  private scheduleRetry(turn: TurnContext, delayMs: number): void {
    if (this.debouncer.hasPending(turn.sessionKey)) return;
    this.debouncer.schedule(turn.sessionKey, delayMs, () => this.respond(turn));
  }

  private async answerPending(turn: TurnContext): Promise<void> {
    const { tenantId, sessionKey, phoneNumber, botConfig, connectionId } = turn;
    const conversationId = turn.conversationId;

    const ownerWindowMs =
      ((botConfig.botResponseDelaySeconds ?? 15) + 5) * 1000;
    const sinceOwner = this.receiptTracker.msSinceActive(sessionKey);
    if (sinceOwner < ownerWindowMs) {
      this.logger.log(
        `Dueño activo en ${sessionKey}. Se responde lo pendiente cuando deje el chat.`,
      );
      this.scheduleRetry(turn, ownerWindowMs - sinceOwner + 1000);
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

    let aiData = await this.conversationService.getConversationForAI(
      conversationId,
      botConfig.maxHistoryMessages,
    );
    if (aiData.pending.length === 0) return;

    this.readGates.set(conversationId, this.markTurnRead(turn, aiData.pending));

    const lastBotMessage = await this.conversationService.lastOutbound(
      botConfig.id,
      phoneNumber,
    );
    const freshStart = this.isIdleSince(
      lastBotMessage,
      botConfig.conversationTimeoutMinutes ?? 60,
      aiData.context,
    );
    if (freshStart && lastBotMessage) {
      this.logger.log(
        `Conversación ${conversationId} sin respuesta de la clienta por más de ${botConfig.conversationTimeoutMinutes ?? 60} min: se empieza de cero.`,
      );
      await this.conversationService.resetConversation(
        conversationId,
        lastBotMessage.at,
      );
      aiData = await this.conversationService.getConversationForAI(
        conversationId,
        botConfig.maxHistoryMessages,
      );
      if (aiData.pending.length === 0) return;
    }

    if (this.conversationService.isBotPaused(aiData.context)) {
      this.logger.debug(
        `Bot en pausa en ${conversationId} (${String(aiData.context.botPauseReason ?? 'sin motivo')}); los mensajes quedan para el equipo.`,
      );
      return;
    }

    if (await this.exceedsReplyBudget(turn, aiData.context)) return;

    const intentText = aiData.pending
      .filter((m) => !m.hasImage)
      .map((m) => m.content)
      .join('\n');
    const intentOutcome = await this.intentHandler.handle({
      tenantId,
      botConfigId: botConfig.id,
      conversationId,
      phoneNumber,
      connectionId,
      text: aiData.pending.some((m) => m.hasImage) ? '' : intentText,
      hasImage: aiData.pending.some((m) => m.hasImage),
      turnId: aiData.pending[aiData.pending.length - 1].id,
      context: aiData.context,
      pendingIds: aiData.pending.map((m) => m.id),
      lastBotMessage: freshStart ? null : lastBotMessage,
      loadTools: () =>
        this.toolDefinitionService.getActiveToolsForBot(botConfig.id),
      send: async (reply) => {
        this.publishResponseRequest(
          conversationId,
          botConfig.id,
          intentText,
          false,
        );
        await this.sendReply(turn, reply, 0);
      },
    });
    if (intentOutcome.handled) return;
    const slim = intentOutcome.slim;

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

    const allTools = await this.toolDefinitionService.getActiveToolsForBot(
      botConfig.id,
    );
    const tools = slim
      ? allTools.filter((t) => slim.tools.includes(t.spec.name))
      : allTools;
    const toolByName = new Map(tools.map((t) => [t.spec.name, t]));
    const readOnlyTools = new Set(
      tools.filter((t) => t.readOnly).map((t) => t.spec.name),
    );

    const promptInput = {
      userMessage: userMessageForAI,
      history: aiData.history,
      context: aiData.context,
      summary: aiData.summary,
      leadingBotMessages: aiData.leadingBotMessages,
      hasImage,
      hasTools: tools.length > 0,
    };
    const builtPrompt = slim
      ? await this.promptEngine.buildSlimPrompt(botConfig.id, slim, promptInput)
      : await this.promptEngine.buildConversationPrompt(
          botConfig.id,
          promptInput,
        );

    let streaks = (aiData.context[FAILURE_STREAKS_KEY] ?? {}) as FailureStreaks;
    const recorded: RecordedOutcome[] = [];
    let modelHandoff = false;
    const record = (
      tool: string,
      outcome: ReturnType<typeof classifyOutcome>,
    ) => {
      recorded.push({ tool, readOnly: readOnlyTools.has(tool), outcome });
    };

    const budget = new TurnBudget();
    const toolExecutorFn = tools.length
      ? async (req: { name: string; arguments: Record<string, unknown> }) => {
          if (budget.expired()) {
            return {
              ok: false,
              content: {
                error: true,
                status: 'TURN_TIMEOUT',
                message:
                  'Se agotó el tiempo del turno; no se ejecutó la acción.',
              },
            };
          }
          const resolved = toolByName.get(req.name);
          if (!resolved) {
            record(req.name, { kind: 'EXPECTED', httpStatus: null });
            return {
              ok: false,
              content: { error: true, message: 'Tool desconocida.' },
            };
          }

          let attachedImage: AttachedImage | undefined;

          if (resolved.requiresImageAttachment) {
            if (!hasImage || !imageMessage) {
              record(req.name, {
                kind: 'EXPECTED',
                httpStatus: null,
                code: 'MISSING_ATTACHMENT',
              });
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
              record(req.name, { kind: 'TECHNICAL', httpStatus: null });
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
            deadlineAt: budget.deadlineAt,
          });

          await this.rememberAction(conversationId, req, outcome);

          const classified = classifyOutcome(
            outcome.status,
            outcome.httpStatus,
            outcome.responseBody,
          );
          record(req.name, classified);
          const streak = nextStreaks(streaks, req.name, classified);
          streaks = streak.streaks;

          if (outcome.status === 'SUCCESS' && resolved.pausesBotMinutes) {
            // Traspaso a una persona: el bot deja de responder en este chat
            // (esta última respuesta sí sale), pero solo si el aviso al equipo
            // quedó verificado.
            modelHandoff = await this.handoffService.afterModelHandoff(
              {
                tenantId,
                botConfigId: botConfig.id,
                conversationId,
                connectionId,
                phoneNumber,
                turnId,
                reason: `Traspaso solicitado (${req.name})`,
                context: aiData.context,
              },
              outcome.responseBody,
              resolved.pausesBotMinutes,
            );
          }

          return {
            ok: outcome.status === 'SUCCESS',
            content: {
              status: outcome.status,
              data: outcome.responseBody,
              error: outcome.status !== 'SUCCESS',
              errorDetail: outcome.errorDetail,
              ...(classified.kind === 'EXPECTED' && {
                expected: true,
                code: classified.code,
                nextStep:
                  streak.count >= EXPECTED_FAILURES_BEFORE_OFFER
                    ? 'OFFER_HANDOFF'
                    : classified.nextStep,
                alternatives: classified.alternatives,
              }),
            },
          };
        }
      : undefined;

    const generate = (
      overrides: {
        reasoningMode?: typeof builtPrompt.reasoningMode;
        maxTokens?: number;
        appendInstruction?: string;
      } = {},
    ) =>
      this.aiOrchestrator.generateResponse({
        botConfigId: botConfig.id,
        systemPrompt: overrides.appendInstruction
          ? `${builtPrompt.systemPrompt}\n\n${overrides.appendInstruction}`
          : builtPrompt.systemPrompt,
        systemBlocks: overrides.appendInstruction
          ? this.systemBlocksOf({
              ...builtPrompt,
              dynamicPrompt: `${builtPrompt.dynamicPrompt ?? ''}\n\n${overrides.appendInstruction}`,
            })
          : this.systemBlocksOf(builtPrompt),
        reasoningMode: overrides.reasoningMode ?? builtPrompt.reasoningMode,
        userMessage: userMessageForAI,
        history: aiData.history,
        context: aiData.context,
        summary: aiData.summary,
        maxTokens: overrides.maxTokens ?? builtPrompt.maxTokens,
        temperature: builtPrompt.temperature,
        tools: tools.length ? tools.map((t) => t.spec) : undefined,
        toolExecutor: toolExecutorFn,
        budget,
      });

    let aiResult: Awaited<ReturnType<AiOrchestrator['generateResponse']>>;
    try {
      aiResult = await generate();
    } catch (error) {
      const detail = maskError(error);
      this.logger.error(`IA no disponible para ${phoneNumber}: ${detail}`);
      await this.handleAiUnavailable(turn, aiData.context, detail);
      return;
    }

    if (isBlank(aiResult.content)) {
      this.replyMetrics.increment('empty');
      this.logger.warn(
        `Respuesta vacía de la IA para ${phoneNumber} (stop=${aiResult.stopReason ?? 'n/d'}); se reintenta sin razonamiento.`,
      );
      try {
        aiResult = await generate({ reasoningMode: 'OFF' });
      } catch (error) {
        const detail = maskError(error);
        this.replyMetrics.increment('emptyFallback');
        await this.handleAiUnavailable(turn, aiData.context, detail);
        return;
      }
      if (isBlank(aiResult.content)) {
        this.replyMetrics.increment('emptyFallback');
        await this.handleAiUnavailable(
          turn,
          aiData.context,
          'La IA devolvió una respuesta vacía dos veces',
        );
        return;
      }
      this.replyMetrics.increment('emptyRecovered');
    }

    if (aiResult.stopReason === 'max_tokens') {
      aiResult = await this.recoverTruncatedReply(
        aiResult,
        builtPrompt.maxTokens,
        phoneNumber,
        generate,
      );
    }

    if (slim?.hint && (slim.endsOnTools?.length ?? 0) > 0) {
      const ran = (aiResult.toolCallsExecuted ?? []).some(
        (call) => call.ok && slim.endsOnTools!.includes(call.name),
      );
      if (!ran) {
        this.replyMetrics.increment('confirmWithoutAction');
        this.logger.warn(
          `La clienta confirmó pero la IA no ejecutó la acción (${slim.endsOnTools!.join(', ')}); se reintenta una vez.`,
        );
        try {
          aiResult = await generate({
            appendInstruction: `ATENCIÓN: la clienta ya confirmó y en tu intento anterior no ejecutaste la acción (${slim.endsOnTools!.join(' o ')}). Ejecútala ahora con las herramientas. No digas que quedó hecha si la herramienta no lo confirma, y no pases a una persona por esto.`,
          });
        } catch (error) {
          this.logger.error(
            `Fallo el reintento de la acción confirmada: ${maskError(error)}`,
          );
        }
      }
    }

    if (this.receiptTracker.isChatActive(sessionKey, 30000)) {
      this.logger.log(
        `Dueño activo mientras la IA procesaba. Respuesta descartada; se reintenta después.`,
      );
      this.scheduleRetry(turn, this.OWNER_DISCARD_RETRY_MS);
      return;
    }

    const guarded = await this.guardReply({
      turn,
      content: aiResult.content,
      recorded,
      modelHandoff,
      context: aiData.context,
      turnId,
      loadTools: () => Promise.resolve(allTools),
      retry: (instruction) => generate({ appendInstruction: instruction }),
    });
    if (
      JSON.stringify(streaks) !==
      JSON.stringify(aiData.context[FAILURE_STREAKS_KEY] ?? {})
    ) {
      await this.conversationService.updateContext(conversationId, {
        contextPatch: { [FAILURE_STREAKS_KEY]: streaks },
      });
    }

    const lastOutbound = aiData.history
      .filter((h) => h.role === 'assistant')
      .at(-1);

    let reply = guarded.content;
    let tokensUsed = aiResult.tokensUsed;

    if (
      !guarded.replaced &&
      lastOutbound &&
      this.isTooSimilar(reply, lastOutbound.content)
    ) {
      this.logger.warn(
        `Respuesta duplicada detectada para ${phoneNumber}. Se genera otra.`,
      );
      try {
        const retryResult = await this.aiOrchestrator.generateResponse({
          botConfigId: botConfig.id,
          systemPrompt: builtPrompt.systemPrompt,
          systemBlocks: this.systemBlocksOf(builtPrompt),
          reasoningMode: builtPrompt.reasoningMode,
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

        reply = retryResult.content;
        if (isBlank(reply)) {
          await this.handleAiUnavailable(
            turn,
            aiData.context,
            'El reintento por respuesta duplicada salió vacío',
          );
          return;
        }
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
    if (slim) {
      await this.intentHandler.afterSlimTurn(
        conversationId,
        slim,
        (aiResult.toolCallsExecuted ?? [])
          .filter((call) => call.ok)
          .map((call) => call.name),
      );
    }

    void this.summarizer.refreshIfNeeded(
      conversationId,
      botConfig.id,
      botConfig.maxHistoryMessages,
    );
  }

  /**
   * La IA no respondió (sin saldo, proveedor caído, sin modelos). La clienta
   * siempre recibe una respuesta: el aviso completo la primera vez y uno más
   * corto si vuelve a fallar dentro de la ventana. El equipo recibe un solo
   * aviso agrupado por bot (AiOutageDigestService), que reintenta si nadie
   * pudo ser notificado.
   * Los mensajes quedan guardados para cuando la IA vuelva.
   */
  private async handleAiUnavailable(
    turn: TurnContext,
    context: Record<string, unknown>,
    detail: string,
  ): Promise<void> {
    const now = Date.now();
    const windowStart =
      typeof context.aiFallbackAt === 'string'
        ? new Date(context.aiFallbackAt).getTime()
        : 0;
    const inWindow = now - windowStart < this.AI_FALLBACK_COOLDOWN_MS;

    await this.sendReply(
      turn,
      await this.handoffService.aiUnavailableText(turn.botConfig.id, inWindow),
      0,
    );

    const teamNotified = inWindow && context.aiFallbackNotified === true;
    if (!teamNotified) {
      this.aiOutageDigest.report(
        turn.tenantId,
        turn.botConfig.id,
        turn.phoneNumber,
        maskSecrets(detail),
      );
    }

    await this.conversationService.updateContext(turn.conversationId, {
      contextPatch: {
        aiFallbackAt: inWindow
          ? context.aiFallbackAt
          : new Date(now).toISOString(),
        aiFallbackNotified: true,
      },
    });
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

  private async recoverTruncatedReply(
    truncated: Awaited<ReturnType<AiOrchestrator['generateResponse']>>,
    configuredMaxTokens: number,
    phoneNumber: string,
    generate: (overrides: {
      reasoningMode?: ReasoningMode;
      maxTokens?: number;
    }) => ReturnType<AiOrchestrator['generateResponse']>,
  ) {
    this.replyMetrics.increment('truncated');
    const ceiling = Math.min(
      configuredMaxTokens * 2,
      BotRouter.TRUNCATED_RETRY_MAX_TOKENS,
    );
    this.logger.warn(
      `Respuesta cortada por tope de tokens para ${phoneNumber}; se regenera con ${ceiling}.`,
    );
    let result = truncated;
    try {
      const retry = await generate({
        reasoningMode: 'OFF',
        maxTokens: ceiling,
      });
      if (!isBlank(retry.content)) result = retry;
    } catch (error) {
      this.logger.warn(
        `No fue posible regenerar la respuesta cortada: ${maskError(error)}`,
      );
    }
    if (result.stopReason !== 'max_tokens') {
      this.replyMetrics.increment('truncatedRecovered');
      return result;
    }
    this.replyMetrics.increment('truncatedCut');
    return { ...result, content: cutAtSentence(result.content) };
  }

  private async sendReply(
    turn: TurnContext,
    content: string,
    tokensUsed: number,
    imageVerified?: boolean,
  ): Promise<void> {
    if (isBlank(content)) {
      this.replyMetrics.increment('blockedEmpty');
      this.logger.error(
        `Se descartó un envío vacío para ${turn.phoneNumber}; no se manda nada al canal.`,
      );
      return;
    }
    await this.readGates.get(turn.conversationId);
    await this.eventBus.publishAsync(EVENT_TYPES.CHANNEL_SEND_REQUESTED, {
      phoneNumber: turn.phoneNumber,
      content,
      conversationId: turn.conversationId,
      connectionId: turn.connectionId,
      tenantId: turn.tenantId,
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

  private systemBlocksOf(prompt: BuiltPrompt): SystemBlocks | undefined {
    return prompt.cacheablePrompt
      ? {
          cacheable: prompt.cacheablePrompt,
          dynamic: prompt.dynamicPrompt ?? '',
        }
      : undefined;
  }

  /**
   * Última red antes de enviar: el bot nunca promete algo que no ocurrió.
   * - Fallo técnico, de permiso o con siguiente paso "traspaso": traspaso real
   *   hecho por el servidor y texto fijo.
   * - Promesa de que una persona escribirá sin traspaso exitoso: traspaso real.
   * - Un fallo esperado de una acción de escritura no se disfraza de éxito.
   * Los fallos esperados (horario ocupado, reserva inexistente) NO escalan: el
   * modelo ofrece alternativas.
   */
  private async guardReply(input: {
    turn: TurnContext;
    content: string;
    recorded: RecordedOutcome[];
    modelHandoff: boolean;
    context: Record<string, unknown>;
    turnId: string;
    loadTools: () => Promise<ResolvedTool[]>;
    retry: (
      instruction: string,
    ) => ReturnType<AiOrchestrator['generateResponse']>;
  }): Promise<{ content: string; replaced: boolean }> {
    const { turn, recorded, modelHandoff } = input;
    const pending = unresolvedFailures(recorded);

    const handoff = async (reason: string) => {
      const result = await this.handoffService.perform({
        tenantId: turn.tenantId,
        botConfigId: turn.botConfig.id,
        conversationId: turn.conversationId,
        connectionId: turn.connectionId,
        phoneNumber: turn.phoneNumber,
        turnId: input.turnId,
        reason,
        context: input.context,
        loadTools: input.loadTools,
      });
      return { content: result.text, replaced: true };
    };

    const fault = pending.find(
      (call) =>
        call.outcome.kind === 'TECHNICAL' ||
        call.outcome.kind === 'PERMISSION' ||
        (call.outcome.kind === 'EXPECTED' &&
          call.outcome.nextStep === 'HANDOFF'),
    );
    if (fault && !modelHandoff) {
      this.replyMetrics.increment('handoffForced');
      this.logger.warn(
        `Traspaso desde el servidor por "${fault.tool}" (${fault.outcome.kind}${fault.outcome.code ? ` ${fault.outcome.code}` : ''}) para ${turn.phoneNumber}.`,
      );
      return handoff(
        `${fault.outcome.kind === 'EXPECTED' ? 'Requiere persona' : 'Fallo técnico'} en ${fault.tool}${fault.outcome.code ? ` (${fault.outcome.code})` : ''}`,
      );
    }

    if (!modelHandoff && promisesHumanContact(input.content)) {
      this.replyMetrics.increment('promiseBlocked');
      this.logger.warn(
        `La IA prometió una persona sin traspaso para ${turn.phoneNumber}; se hace el traspaso real.`,
      );
      return handoff(
        'La IA prometió que una persona escribiría sin haber hecho el traspaso',
      );
    }

    const writeFailure = pending.find(
      (call) => !call.readOnly && call.outcome.kind === 'EXPECTED',
    );
    if (writeFailure && claimsCompleted(input.content)) {
      this.replyMetrics.increment('successClaimBlocked');
      const { code, message, nextStep } = writeFailure.outcome;
      try {
        const second = await input.retry(
          `ATENCIÓN: ${writeFailure.tool} falló (${code ?? 'error'}: ${message ?? 'sin detalle'}) y NO se hizo. No digas que quedó hecho: explícaselo a la clienta en una frase simple${nextStep ? ` y sigue este paso: ${nextStep}` : ' y ofrece una alternativa'}.`,
        );
        if (!claimsCompleted(second.content) && !isBlank(second.content)) {
          return { content: second.content, replaced: false };
        }
      } catch (error) {
        this.logger.error(
          `Fallo el reintento por éxito falso: ${maskError(error)}`,
        );
      }
      return {
        content: `No pude completarlo: ${message ?? 'el sistema no lo permitió'}`,
        replaced: true,
      };
    }

    return { content: input.content, replaced: false };
  }

  /**
   * Mensaje que llegó con demasiada antigüedad para responderse solo (por
   * ejemplo tras una caída larga): se guarda para que el equipo lo vea y
   * queda fuera de lo pendiente del bot. Devuelve el chat afectado.
   */
  async recordMissedInbound(
    message: WAMessage,
    botConfigId: string,
    connectionId: string,
    tenantId: string,
  ): Promise<string | null> {
    const jid = message.key.remoteJidAlt ?? message.key.remoteJid;
    const messageId = message.key.id;
    if (!jid || !messageId || isIgnorableJid(jid)) return null;

    const { text, hasImage } = this.extractContent(message);
    if (!text && !hasImage) return null;

    const botConfig = await this.botConfigService.getConfigForRouting(
      botConfigId,
      tenantId,
    );
    if (!botConfig) return null;

    const phoneNumber = conversationAddress(jid);
    const conversation = await this.conversationService.getOrCreate({
      botConfigId: botConfig.id,
      phoneNumber,
      tenantId: botConfig.tenantId,
      connectionId,
    });
    const saved = await this.conversationService.saveInbound(
      conversation.id,
      text ?? '[imagen]',
      hasImage,
      connectionId,
      { waMessageId: messageId, processedBy: EXPIRED_REPLY },
    );
    return saved.created ? phoneNumber : null;
  }

  async registerHumanMessage(
    message: WAMessage,
    botConfigId: string,
    connectionId: string,
    tenantId: string,
  ): Promise<void> {
    const jid = message.key.remoteJidAlt ?? message.key.remoteJid;
    if (!jid || isIgnorableJid(jid)) return;

    const sessionKey = chatKey(connectionId, jid);
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
    if (!na || !nb) return false;

    if (na === nb) return true;

    if (na.includes(nb) || nb.includes(na)) return true;

    return false;
  }

  /**
   * Marca como leídos todos los mensajes del turno tras una pausa humana
   * (1–4 s), en paralelo con la IA. La respuesta espera a esta lectura
   * (`sendReply`), así que el orden es siempre leído → escribiendo → envío.
   */
  private async markTurnRead(
    turn: TurnContext,
    pending: Array<{ waMessageId: string | null }>,
  ): Promise<void> {
    try {
      const ids = pending
        .map((m) => m.waMessageId)
        .filter((id): id is string => !!id);
      const sock = this.sessionManager.get(turn.connectionId);
      if (ids.length === 0 || !sock) return;

      await this.sleep(readDelayMs());
      const remoteJid = isLidAddress(turn.phoneNumber)
        ? turn.phoneNumber
        : phoneToJid(turn.phoneNumber);
      await sock.readMessages(
        ids.map((id) => ({ remoteJid, id, fromMe: false })),
      );
    } catch (err) {
      this.logger.debug(
        `no se puede marcar como leído: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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

const COMPLETED_CLAIM =
  /\b(?:qued[oó]|quedaron|ya est[aá]|fue|ha sido|se (?:agend[oó]|reserv[oó]|cancel[oó]|reagend[oó]|registr[oó]|cre[oó]))\s*(?:ya\s*)?(?:agendad[ao]s?|reservad[ao]s?|cancelad[ao]s?|reagendad[ao]s?|confirmad[ao]s?|registrad[ao]s?|cread[ao]s?)?\b/i;
const COMPLETED_WORD =
  /\b(?:agendad[ao]|reservad[ao]|cancelad[ao]|reagendad[ao]|confirmad[ao]|registrad[ao]|cread[ao])\b|\bse (?:agend[oó]|reserv[oó]|cancel[oó]|reagend[oó]|registr[oó]|cre[oó])\b/i;

function claimsCompleted(text: string): boolean {
  return COMPLETED_CLAIM.test(text) && COMPLETED_WORD.test(text);
}
