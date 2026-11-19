import { LegacyImageUsageService } from '../ai/LegacyImageUsage.service';
import {
  IMAGE_NOT_ANALYZED,
  IMAGE_WARNING_KEY,
  ImageNotAnalyzedReason,
} from '../conversation/image-warning';
import {
  forwardRef,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { BotConfigService } from '../config/BotConfigService';
import { ConversationService } from '../conversation/ConversationService';
import { downloadMediaMessage, WAMessage } from '@whiskeysockets/baileys';
import { BotStatus, ReasoningMode } from '@prisma/client';
import { EventBusService } from 'src/infra/events/event.service';
import { EVENT_TYPES } from 'src/infra/events/constants/event.types';
import { AiOrchestrator } from '../ai/AiOrchestrator';
import {
  ImageAnalysisResult,
  ImageAnalysisService,
} from '../ai/ImageAnalysisService';
import {
  PreparedImage,
  SpecialistRunOutcome,
  SpecialistRuntime,
  prepareImage,
} from '../specialists/SpecialistRuntime';
import { MAX_TIMEOUT_MS } from '../specialists/contracts';
import {
  IMAGE_ANALYSIS_CAPABILITY,
  SPECIALIST_BLOCK_TEXT,
} from '../specialists/constants';
import {
  FACTS_KEY,
  buildFact,
  markConsumed,
  mergeFacts,
} from '../specialists/facts';
import { ConversationContext } from '../conversation/interfaces/ConversationContext';
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
import {
  AudioTranscriptionService,
  transcribedContent,
} from '../ai/AudioTranscriptionService';
import { SystemPauseService } from '../pause/SystemPause.service';
import { FAILURE_STREAKS_KEY } from '../handoff/handoff-defaults';
import { promisesHumanContact } from '../handoff/handoff-promise';
import { TurnBudget } from '../ai/turn-budget';
import { limitToolData } from '../tools/tool-result-limit';
import { formatTurnLine, maskChat, ToolTrace } from './turn-trace';
import {
  jittered,
  readDelayMs,
} from 'src/channels/whatsapp/baileys/human-timing';
import { IntentHandler } from '../intent/IntentHandler';
import { IntentOutcome, isTaskDone } from '../intent/intent-turn';
import { proposesSingleSlot } from '../intent/slot-proposal';
import { isAffirmation } from '../intent/normalize';
import { findRepeatedQuestion } from './repeated-question';
import {
  announcesPendingCheck,
  isNoReply,
  NO_REPLY_CONFIRM_INSTRUCTION,
  QUIET_NO_REPLY_CONFIRM_INSTRUCTION,
  askedDayInstruction,
  asksForDay,
  deniesOffer,
  uncheckedDenialInstruction,
  leaksInternals,
  scrubInternals,
  TECHNICAL_LEAK_INSTRUCTION,
  STALLED_REPLY_INSTRUCTION,
} from './stalled-reply';
import { withNotices } from './notice-coverage';
import { MessageRole } from '../conversation/types/MessageRole';
import { AiOutageDigestService } from '../tools/AiOutageDigest.service';
import { ImagePrefetchService } from './ImagePrefetch.service';
import { BotEscalationService } from '../tools/BotEscalation.service';
import { ConversationSummarizer } from '../conversation/ConversationSummarizer';
import {
  acknowledgesOnly,
  isIgnorableAcknowledgement,
} from './acknowledgement';
import {
  firstContactNoticeOf,
  handoffQuietNote,
  silenceNeedsCheck,
  personalChatNote,
  personalChatPatch,
} from './chat-situation';
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
  reportsTeamNotified,
} from '../tools/tool-outcome';
import { cutAtSentence, isBlank } from './reply-guard';
import { ReplyMetricsService } from './reply-metrics.service';
import { RetainedImages } from './retained-images';
import { shownOutcomes } from './image-outcomes';
import { OutboundReplyService } from 'src/channels/whatsapp/outbox/OutboundReply.service';

interface TurnContext {
  tenantId: string;
  sessionKey: string;
  phoneNumber: string;
  botConfig: any;
  connectionId: string;
  conversationId: string;
  /**
   * Hora del último mensaje del cliente que la pasada en curso está
   * contestando. Con ella se sabe si, al salir la respuesta, el cliente ya
   * escribió algo más y la respuesta quedó desactualizada.
   */
  answeredUntil?: Date | null;
}

/** Cómo debe salir una respuesta. */
interface ReplyOptions {
  /**
   * La respuesta ya está comprometida (el turno hizo una reserva, un traspaso,
   * una verificación…): sale aunque el cliente escriba de nuevo, porque el
   * cliente debe enterarse de lo que ya pasó.
   */
  mustDeliver?: boolean;
}

export interface IncomingMessageDto {
  phoneNumber: string;
  content: string;
  hasImage: boolean;
  imageUrl?: string;
}

type CapabilityOutcome = Extract<SpecialistRunOutcome, { executed: true }> & {
  capability: string;
};

export type ImageBundle =
  | { kind: 'LEGACY'; result: ImageAnalysisResult }
  | { kind: 'ACTIVE'; outcomes: CapabilityOutcome[] }
  | { kind: 'UNANALYZED' }
  | { kind: 'SKIPPED' };

interface ImageJob {
  botConfigId: string;
  systemPrompt: string;
  conversationId: string;
  tenantId: string;
  phoneNumber: string;
}

type ImageApplication =
  | { kind: 'REPLY'; text: string }
  | { kind: 'CONTINUE'; prefix: string | null; imageVerified?: boolean };

@Injectable()
export class BotRouter {
  private readonly logger = new Logger(BotRouter.name);

  private readonly processingConversations = new Set<string>();
  /** Conversaciones que recibieron mensajes mientras se procesaban. */
  private readonly rerunRequested = new Set<string>();
  /** Último mensaje con imagen por conversación, para analizarla o adjuntarla. */
  private readonly retainedImages = new RetainedImages<WAMessage>();
  private readonly TYPING_RETRY_MS = 6000;
  /** Tope de espera por un cliente que sigue escribiendo antes de enviarle la respuesta ya lista. */
  private readonly TYPING_HOLD_MAX_MS = 45_000;
  /** Margen tras dejar de escribir: puede retomar o enviar enseguida. */
  private readonly TYPING_SETTLE_MS = 2_500;
  private readonly TYPING_POLL_MS = 1_000;
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
    private readonly systemPause: SystemPauseService,
    private readonly specialistRuntime: SpecialistRuntime,
    private readonly imagePrefetch: ImagePrefetchService<ImageBundle>,
    @Optional() private readonly legacyUsage?: LegacyImageUsageService,
    @Optional() private readonly outbox?: OutboundReplyService,
    @Optional()
    private readonly audioTranscription?: AudioTranscriptionService,
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

    const botInactive = botConfig.status !== BotStatus.ACTIVE;
    if (botInactive) {
      this.logger.warn(
        `El bot "${botConfig.name}" (${botConfig.id}) de la conexión ${connectionId} ` +
          `está en estado ${botConfig.status}, no ACTIVE: el mensaje de ${phoneNumber} ` +
          `se guarda sin respuesta automática. Actívalo desde el panel para que responda.`,
      );
    }

    const paused = await this.systemPause.isPaused(tenantId);
    const silent = botInactive || paused;

    const messageTimestap = Number(message.messageTimestamp ?? 0) * 1000;
    const messageAgeMs = Date.now() - messageTimestap;
    const MaxAgeMs = (botConfig.maxMessageAgeMinutes ?? 1440) * 60 * 1000;

    if (messageAgeMs > MaxAgeMs) {
      this.logger.debug(
        `Mensage de ${phoneNumber} igonrado: anguedad ${Math.round(messageAgeMs / 60000)} min > limite ${botConfig.maxMessageAgeMinutes} min`,
      );

      if (!silent) await this.markAsRead(message, connectionId);
      return;
    }

    const extracted = this.extractContent(message);
    const { hasImage } = extracted;
    let text = extracted.text;
    if (!silent && message.message?.audioMessage && this.audioTranscription) {
      const result = await this.audioTranscription.transcribe(
        message,
        botConfig.id,
      );
      this.replyMetrics.increment(
        result.kind === 'TEXT'
          ? 'audioTranscribed'
          : result.kind === 'TOO_LONG'
            ? 'audioTooLong'
            : 'audioUntranscribed',
      );
      text = transcribedContent(result);
    }

    if (!text && !hasImage) {
      if (!silent) await this.markAsRead(message, connectionId);
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
        processedBy: ignorable || silent ? IGNORED_INBOUND : undefined,
      },
    );
    if (!saved.created) {
      this.logger.debug(
        `Mensaje ${messageId} ya guardado; se ignora el duplicado.`,
      );
      return;
    }

    if (silent) {
      this.logger.debug(
        `${paused ? 'Sistema en pausa' : 'Bot apagado'}: mensaje de ${phoneNumber} guardado sin respuesta automática.`,
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

    await this.discardOutdatedReplies(conversation.id, phoneNumber);

    if (hasImage) {
      this.retainedImages.keep(conversation.id, message);
      const routing = botConfig as {
        id: string;
        systemPrompt: string;
        imageAnalysisEnabled?: boolean | null;
        botResponseDelaySeconds?: number | null;
        humanTakeoverMinutes?: number | null;
      };
      if (
        routing.imageAnalysisEnabled &&
        !this.conversationService.isBotPaused(
          conversation.context as ConversationContext,
        )
      ) {
        this.imagePrefetch.schedule(conversation.id, messageId, async () => {
          if (!(await this.teamIsAway(routing, sessionKey, phoneNumber))) {
            return { kind: 'SKIPPED' };
          }
          return this.buildImageBundle({
            message,
            botConfigId: routing.id,
            systemPrompt: routing.systemPrompt,
            conversationId: conversation.id,
            tenantId,
            phoneNumber,
          });
        });
      }
    }

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

    if (await this.systemPause.isPaused(turn.tenantId)) {
      this.logger.debug(
        `Sistema en pausa: no se responde la conversación ${id}.`,
      );
      return;
    }

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
          // Si el cliente aún está juntando mensajes, su lote dispara la
          // siguiente pasada cuando termine la espera: repetir ya mismo
          // contestaría a media frase.
        } while (
          this.rerunRequested.has(id) &&
          !this.debouncer.hasPending(turn.sessionKey)
        );
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

  private ownerWindowMs(botConfig: {
    botResponseDelaySeconds?: number | null;
  }): number {
    return ((botConfig.botResponseDelaySeconds ?? 15) + 5) * 1000;
  }

  private async teamIsAway(
    botConfig: {
      id: string;
      botResponseDelaySeconds?: number | null;
      humanTakeoverMinutes?: number | null;
    },
    sessionKey: string,
    phoneNumber: string,
  ): Promise<boolean> {
    if (
      this.receiptTracker.msSinceActive(sessionKey) <
      this.ownerWindowMs(botConfig)
    ) {
      return false;
    }
    return (
      (await this.humanTakeoverEndsAt(
        botConfig.id,
        phoneNumber,
        botConfig.humanTakeoverMinutes ?? 10,
      )) === null
    );
  }

  private scheduleRetry(turn: TurnContext, delayMs: number): void {
    if (this.debouncer.hasPending(turn.sessionKey)) return;
    this.debouncer.schedule(turn.sessionKey, delayMs, () => this.respond(turn));
  }

  private async answerPending(turn: TurnContext): Promise<void> {
    const { tenantId, sessionKey, phoneNumber, botConfig, connectionId } = turn;
    const conversationId = turn.conversationId;

    const ownerWindowMs = this.ownerWindowMs(botConfig);
    const sinceOwner = this.receiptTracker.msSinceActive(sessionKey);
    if (sinceOwner < ownerWindowMs) {
      this.logger.log(
        `Dueño activo en ${sessionKey}. Se responde lo pendiente cuando deje el chat.`,
      );
      this.scheduleRetry(turn, ownerWindowMs - sinceOwner + 1000);
      return;
    }

    const takeoverEndsAt = await this.humanTakeoverEndsAt(
      botConfig.id,
      phoneNumber,
      botConfig.humanTakeoverMinutes ?? 10,
    );
    if (takeoverEndsAt) {
      this.logger.log(
        `Takeover humano para ${phoneNumber}. Bot en pausa; si nadie del equipo contesta, lo pendiente se responde a las ${takeoverEndsAt.toISOString()}.`,
      );
      this.scheduleRetry(
        turn,
        Math.max(takeoverEndsAt.getTime() - Date.now(), 0) + 1000,
      );
      return;
    }

    if (this.receiptTracker.isTyping(sessionKey)) {
      this.logger.debug(
        `Cliente escribiendo en ${sessionKey}: se espera a que termine.`,
      );
      this.scheduleRetry(turn, this.TYPING_RETRY_MS);
      return;
    }

    turn.answeredUntil = null;
    let aiData = await this.conversationService.getConversationForAI(
      conversationId,
      botConfig.maxHistoryMessages,
    );
    if (aiData.pending.length === 0) return;
    turn.answeredUntil = this.lastInboundAt(aiData.pending);

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
      turn.answeredUntil = this.lastInboundAt(aiData.pending);
    }

    let handoffQuiet = false;
    if (this.conversationService.isBotPaused(aiData.context)) {
      const leaveToTeam =
        !this.handoffService.isActive(aiData.context) ||
        aiData.pending.some((m) => m.hasImage);
      if (leaveToTeam) {
        this.logger.debug(
          `Bot en pausa en ${conversationId} (${String(aiData.context.botPauseReason ?? 'sin motivo')}); los mensajes quedan para el equipo.`,
        );
        return;
      }
      if (aiData.pending.every((m) => acknowledgesOnly(m.content))) {
        this.replyMetrics.increment('silenced');
        this.logger.log(
          `Chat ${conversationId} ya traspasado al equipo: un agradecimiento o acuse no se responde.`,
        );
        await this.conversationService.ignorePending(
          aiData.pending.map((m) => m.id),
        );
        return;
      }
      handoffQuiet = true;
    }

    if (await this.exceedsReplyBudget(turn, aiData.context)) return;

    const intentText = aiData.pending
      .filter((m) => !m.hasImage)
      .map((m) => m.content)
      .join('\n');
    const intentOutcome: IntentOutcome = handoffQuiet
      ? { handled: false }
      : await this.intentHandler.handle({
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
            // Reglas e intenciones fijas (baja, abuso…) ya dejaron su efecto.
            await this.sendReply(turn, reply, 0, undefined, {
              mustDeliver: true,
            });
          },
        });
    if (intentOutcome.handled) return;
    const slim = intentOutcome.slim;
    const notices = [...(intentOutcome.notices ?? [])];

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
    const imageMessage = this.retainedImages.get(conversationId);
    const imageAvailable = hasImage || !!imageMessage;

    let userMessageForAI = combinedText || '[imagen recibida]';
    if (!hasImage && imageMessage) {
      userMessageForAI = `[la clienta ya envió una imagen en esta conversación y sigue disponible para registrarla]\n${userMessageForAI}`;
    }
    let imageVerified: boolean | undefined;

    if (hasImage && imageMessage && botConfig.imageAnalysisEnabled) {
      const routing = botConfig as { id: string; systemPrompt: string };
      const bundle = await this.resolveImageBundle(imageMessage, {
        botConfigId: routing.id,
        systemPrompt: routing.systemPrompt,
        conversationId,
        tenantId,
        phoneNumber,
      });
      const applied = await this.applyImageBundle(bundle, {
        conversationId,
        phoneNumber,
        aiData,
      });
      if (applied.kind === 'REPLY') {
        await this.sendReply(turn, applied.text, 0, undefined, {
          mustDeliver: true,
        });
        return;
      }
      imageVerified = applied.imageVerified;
      if (applied.prefix) {
        userMessageForAI = combinedText
          ? `${applied.prefix}\n${combinedText}`
          : applied.prefix;
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
    const affirmsSlot =
      !freshStart &&
      lastBotMessage?.content.includes('?') === true &&
      ACTION_PROPOSAL.test(lastBotMessage.content) &&
      proposesSingleSlot(lastBotMessage.content) &&
      isAffirmation(intentText);
    const tools = (
      slim ? allTools.filter((t) => slim.tools.includes(t.spec.name)) : allTools
    )
      .filter(
        (t) =>
          !(handoffQuiet || affirmsSlot) || (t.pausesBotMinutes ?? 0) === 0,
      )
      .filter((t) => !affirmsSlot || !t.readOnly || t.pinResultInMemory);
    const toolByName = new Map(tools.map((t) => [t.spec.name, t]));
    const readOnlyTools = new Set(
      tools.filter((t) => t.readOnly).map((t) => t.spec.name),
    );

    const situation: string[] = [];
    if (handoffQuiet) situation.push(handoffQuietNote(aiData.context));
    const personalNote = handoffQuiet ? null : personalChatNote(aiData.context);
    if (personalNote) situation.push(personalNote);
    const firstContact =
      !handoffQuiet &&
      !personalNote &&
      !(await this.conversationService.assistantHasReplied(
        botConfig.id,
        phoneNumber,
      ));
    let firstContactNotice: string | null = null;

    const promptInput = {
      userMessage: userMessageForAI,
      history: aiData.history,
      context: aiData.context,
      summary: aiData.summary,
      leadingBotMessages: aiData.leadingBotMessages,
      notices: notices.map((notice) => notice.text),
      situation,
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
    const toolTraces: ToolTrace[] = [];
    const turnStartedAt = Date.now();
    let modelHandoff = false;
    let imageConsumed = false;
    const record = (
      tool: string,
      outcome: ReturnType<typeof classifyOutcome>,
      body?: unknown,
    ) => {
      recorded.push({
        tool,
        readOnly: readOnlyTools.has(tool),
        outcome,
        teamNotified: outcome.kind === 'SUCCESS' && reportsTeamNotified(body),
      });
      const notice =
        outcome.kind === 'SUCCESS' ? firstContactNoticeOf(body) : null;
      if (notice) firstContactNotice = notice;
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
            if (!imageAvailable || !imageMessage) {
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
                    'La clienta no ha enviado ninguna imagen reciente en esta conversación. Pídele que la envíe por este chat.',
                },
              };
            }

            try {
              const buffer = await downloadMediaMessage(
                imageMessage,
                'buffer',
                {},
              );

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

          const toolStartedAt = Date.now();
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

          if (resolved.requiresImageAttachment && outcome.status === 'SUCCESS')
            imageConsumed = true;
          if (resolved.verificationCapability && outcome.status === 'SUCCESS') {
            await this.markFactConsumed(
              conversationId,
              resolved.verificationCapability,
              aiData,
            );
          }
          const limited = limitToolData(outcome.responseBody);
          toolTraces.push({
            name: req.name,
            ok: outcome.status === 'SUCCESS',
            ms: Date.now() - toolStartedAt,
            bytes: limited.chars,
            truncated: limited.truncated,
          });

          await this.rememberAction(
            conversationId,
            req,
            outcome,
            resolved.pinResultInMemory,
          );

          const classified = classifyOutcome(
            outcome.status,
            outcome.httpStatus,
            outcome.responseBody,
          );
          record(req.name, classified, outcome.responseBody);
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
              data: limited.data,
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

    // Antes de gastar tokens: si el cliente ya escribió algo más, esta pasada
    // contestaría una versión vieja. Su mensaje dispara otra pasada con todo
    // junto, así se responde una sola vez y con lo más reciente.
    if (
      await this.conversationService.hasNewInboundSince(
        conversationId,
        turn.answeredUntil,
      )
    ) {
      this.replyMetrics.increment('superseded');
      this.logger.log(
        `El cliente escribió de nuevo antes de llamar a la IA en ${conversationId}: se espera para responder con todo junto.`,
      );
      return;
    }

    let aiResult: Awaited<ReturnType<AiOrchestrator['generateResponse']>>;
    try {
      aiResult = await generate();
    } catch (error) {
      const detail = maskError(error);
      this.logger.error(`IA no disponible para ${phoneNumber}: ${detail}`);
      await this.handleAiUnavailable(turn, aiData.context, detail);
      return;
    }

    if (
      isNoReply(aiResult.content) &&
      (aiResult.toolCallsExecuted ?? []).some(
        (call) => call.ok && !readOnlyTools.has(call.name),
      )
    ) {
      aiResult = { ...aiResult, content: '' };
    }

    if (
      isNoReply(aiResult.content) &&
      !silenceNeedsCheck(handoffQuiet, personalNote, combinedText)
    ) {
      this.replyMetrics.increment('silenced');
      this.logger.log(
        `La IA juzgó que el mensaje de ${maskChat(phoneNumber)} no es para el negocio (${handoffQuiet ? 'chat ya traspasado y sin pregunta de citas' : 'sigue una charla personal'}): no se responde.`,
      );
      await this.silenceTurn(conversationId, aiData.pending, handoffQuiet);
      return;
    }

    if (isNoReply(aiResult.content)) {
      this.replyMetrics.increment('silenceChecked');
      let second: typeof aiResult | null = null;
      try {
        second = await generate({
          appendInstruction: handoffQuiet
            ? QUIET_NO_REPLY_CONFIRM_INSTRUCTION
            : NO_REPLY_CONFIRM_INSTRUCTION,
        });
      } catch (error) {
        this.logger.warn(
          `No se pudo confirmar el silencio para ${maskChat(phoneNumber)}: ${maskError(error)}`,
        );
      }
      if (!second || isNoReply(second.content)) {
        this.replyMetrics.increment('silenced');
        this.logger.log(
          `La IA juzgó dos veces que el mensaje de ${maskChat(phoneNumber)} no es para el negocio: no se responde y queda para el equipo.`,
        );
        await this.silenceTurn(conversationId, aiData.pending, handoffQuiet);
        return;
      }
      this.replyMetrics.increment('silenceOverturned');
      aiResult = second;
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
      if (isBlank(aiResult.content) || isNoReply(aiResult.content)) {
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

    const confirmedProposal =
      !slim?.hint &&
      lastBotMessage?.content.includes('?') === true &&
      ACTION_PROPOSAL.test(lastBotMessage.content) &&
      isAffirmation(combinedText);
    const wrote = (result: typeof aiResult) =>
      (result.toolCallsExecuted ?? []).some(
        (call) => call.ok && !readOnlyTools.has(call.name),
      );
    let consistencyRetried = false;
    if (
      confirmedProposal &&
      claimsCompleted(aiResult.content) &&
      !wrote(aiResult)
    ) {
      consistencyRetried = true;
      this.replyMetrics.increment('confirmWithoutAction');
      this.logger.warn(
        `La clienta confirmó y la IA dijo que quedó hecho sin ejecutar ninguna acción para ${maskChat(phoneNumber)}; se reintenta una vez.`,
      );
      let retried: typeof aiResult | null = null;
      try {
        retried = await generate({
          appendInstruction:
            'ATENCIÓN: la clienta acaba de confirmar y en tu intento anterior dijiste que quedó hecho sin ejecutar ninguna herramienta, así que NO se hizo. Ejecuta ahora la herramienta que corresponde a lo que confirmó (por ejemplo crear_reserva_whatsapp) y responde según su resultado real. Si lo que confirmó no era una acción, responde sin decir que quedó hecho. No digas que quedó hecho si una herramienta no lo confirma.',
        });
      } catch (error) {
        this.logger.error(
          `Fallo el reintento de la acción confirmada: ${maskError(error)}`,
        );
      }
      aiResult =
        retried &&
        !isBlank(retried.content) &&
        (wrote(retried) || !claimsCompleted(retried.content))
          ? retried
          : {
              ...aiResult,
              content: UNCONFIRMED_ACTION_TEXT,
            };
    }

    if (
      !consistencyRetried &&
      confirmedProposal &&
      proposesSingleSlot(lastBotMessage?.content ?? '') &&
      !wrote(aiResult)
    ) {
      consistencyRetried = true;
      this.replyMetrics.increment('confirmWithoutAction');
      this.logger.warn(
        `La clienta aceptó el horario propuesto y la IA no ejecutó ninguna acción para ${maskChat(phoneNumber)}; se reintenta una vez.`,
      );
      try {
        const retried = await generate({
          appendInstruction: slotConfirmedInstruction(combinedText),
        });
        if (!isBlank(retried.content)) {
          aiResult =
            claimsCompleted(retried.content) && !wrote(retried)
              ? { ...retried, content: UNCONFIRMED_ACTION_TEXT }
              : retried;
        }
      } catch (error) {
        this.logger.error(
          `Fallo el reintento del horario aceptado: ${maskError(error)}`,
        );
      }
    }

    if (!consistencyRetried && !isBlank(aiResult.content)) {
      const asksAgain =
        confirmedProposal &&
        !wrote(aiResult) &&
        aiResult.content
          .split(/\n+/)
          .filter((bubble) => bubble.includes('?'))
          .some(
            (bubble) =>
              ACTION_PROPOSAL.test(bubble) || RECONFIRMATION.test(bubble),
          );
      const repeated = asksAgain
        ? null
        : findRepeatedQuestion(aiResult.content, [
            ...aiData.history.map((m) => ({
              fromBot: m.role === MessageRole.ASSISTANT,
              content: m.content,
            })),
            { fromBot: false, content: combinedText },
          ]);
      if (asksAgain || repeated) {
        this.replyMetrics.increment('repeatedQuestion');
        this.logger.warn(
          `La IA volvió a preguntar algo ya respondido para ${maskChat(phoneNumber)}${asksAgain ? ' (otra confirmación tras un sí)' : ''}; se reintenta una vez.`,
        );
        const instruction = asksAgain
          ? `ATENCIÓN: la clienta ya confirmó («${combinedText.slice(0, 200)}»). No le pidas otra confirmación: ejecuta ahora la acción con la herramienta que corresponde y responde según su resultado real. Si en tu propuesta anterior no le avisaste de los términos del servicio, menciónalo en esta misma respuesta.`
          : `ATENCIÓN: tu respuesta vuelve a preguntar algo que la clienta ya contestó (preguntaste «${repeated!.previous.slice(0, 200)}» y respondió «${repeated!.answer.slice(0, 200)}»). No repitas esa pregunta: usa lo que respondió y avanza. Si su respuesta no trae el dato que necesitas, pídelo de otra forma en una sola frase diciendo para qué es.`;
        try {
          const retried = await generate({ appendInstruction: instruction });
          if (!isBlank(retried.content)) {
            aiResult =
              claimsCompleted(retried.content) && !wrote(retried)
                ? { ...retried, content: UNCONFIRMED_ACTION_TEXT }
                : retried;
          }
        } catch (error) {
          this.logger.error(
            `Fallo el reintento por pregunta repetida: ${maskError(error)}`,
          );
        }
      }
    }

    if (
      !consistencyRetried &&
      (aiResult.toolCallsExecuted ?? []).length === 0 &&
      announcesPendingCheck(aiResult.content)
    ) {
      this.replyMetrics.increment('stalledReply');
      this.logger.warn(
        `La IA anunció que iba a revisar sin llamar herramientas para ${maskChat(phoneNumber)}; se reintenta una vez.`,
      );
      try {
        const retried = await generate({
          appendInstruction: STALLED_REPLY_INSTRUCTION,
        });
        if (!isBlank(retried.content)) {
          aiResult =
            claimsCompleted(retried.content) && !wrote(retried)
              ? { ...retried, content: UNCONFIRMED_ACTION_TEXT }
              : retried;
        }
      } catch (error) {
        this.logger.error(
          `Fallo el reintento por respuesta sin consulta: ${maskError(error)}`,
        );
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

    if (isNoReply(guarded.content)) {
      this.replyMetrics.increment('silenced');
      this.logger.log(
        `La IA marcó [NO_RESPONDER] tras un reintento para ${maskChat(phoneNumber)}: no se responde y queda para el equipo.`,
      );
      await this.silenceTurn(conversationId, aiData.pending, handoffQuiet);
      return;
    }

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

    const slotTools = tools
      .map((t) => t.spec.name)
      .filter((name) => /disponib|availab|horario|slot/i.test(name));
    const calledSlots = (aiResult.toolCallsExecuted ?? []).some((call) =>
      slotTools.includes(call.name),
    );
    if (
      !guarded.replaced &&
      !consistencyRetried &&
      slotTools.length > 0 &&
      !calledSlots &&
      !wrote(aiResult) &&
      asksForDay(reply)
    ) {
      this.replyMetrics.increment('askedDayNotSlots');
      this.logger.warn(
        `La IA preguntó el día en vez de ofrecer cupos para ${maskChat(phoneNumber)}; se reintenta una vez.`,
      );
      try {
        const retried = await generate({
          appendInstruction: askedDayInstruction(slotTools),
        });
        if (
          !isBlank(retried.content) &&
          !isNoReply(retried.content) &&
          !(claimsCompleted(retried.content) && !wrote(retried))
        ) {
          reply = retried.content;
        }
      } catch (error) {
        this.logger.error(
          `Fallo el reintento para ofrecer cupos: ${maskError(error)}`,
        );
      }
    }

    if (
      !guarded.replaced &&
      tools.length > 0 &&
      (aiResult.toolCallsExecuted ?? []).length === 0 &&
      deniesOffer(reply)
    ) {
      this.replyMetrics.increment('uncheckedDenial');
      this.logger.warn(
        `La IA dijo que algo no existe sin revisarlo para ${maskChat(phoneNumber)}; se reintenta una vez.`,
      );
      try {
        const retried = await generate({
          appendInstruction: uncheckedDenialInstruction(
            tools
              .filter((t) => readOnlyTools.has(t.spec.name))
              .map((t) => t.spec.name),
          ),
        });
        if (
          !isBlank(retried.content) &&
          !isNoReply(retried.content) &&
          (retried.toolCallsExecuted ?? []).length > 0 &&
          !(claimsCompleted(retried.content) && !wrote(retried))
        ) {
          aiResult = retried;
          reply = retried.content;
        }
      } catch (error) {
        this.logger.error(
          `Fallo el reintento para revisar antes de negar: ${maskError(error)}`,
        );
      }
    }

    const toolNames = allTools.map((t) => t.spec.name);
    if (!guarded.replaced && leaksInternals(reply, toolNames)) {
      this.replyMetrics.increment('technicalLeak');
      this.logger.warn(
        `La respuesta para ${maskChat(phoneNumber)} mostraba detalles internos; se reescribe.`,
      );
      let rewritten: string | null = null;
      if (!wrote(aiResult)) {
        try {
          const retried = await generate({
            appendInstruction: TECHNICAL_LEAK_INSTRUCTION,
          });
          if (
            !isBlank(retried.content) &&
            !isNoReply(retried.content) &&
            !leaksInternals(retried.content, toolNames) &&
            !(claimsCompleted(retried.content) && !wrote(retried))
          ) {
            rewritten = retried.content;
          }
        } catch (error) {
          this.logger.error(
            `Fallo la reescritura sin detalles internos: ${maskError(error)}`,
          );
        }
      }
      reply = rewritten ?? scrubInternals(reply, toolNames);
      if (isBlank(reply)) reply = UNCONFIRMED_ACTION_TEXT;
    }

    // Se espera el envío dentro del lock: la respuesta queda guardada antes
    // de la siguiente pasada, así lo ya respondido no vuelve a verse como
    // pendiente (evita contestar dos veces lo mismo).
    // Si el turno ya hizo algo con efectos (una reserva, un traspaso), el
    // cliente tiene que enterarse aunque haya escrito de nuevo.
    const deliverable =
      firstContact && firstContactNotice && !modelHandoff
        ? [...notices, { key: 'first_contact', text: firstContactNotice }]
        : notices;
    if (!guarded.replaced && deliverable.length > 0) {
      reply = withNotices(
        reply,
        deliverable.map((notice) => notice.text),
      );
    }

    const mustDeliver =
      modelHandoff ||
      recorded.some((r) => !r.readOnly && r.outcome.kind === 'SUCCESS');
    const sent = await this.sendReply(turn, reply, tokensUsed, imageVerified, {
      mustDeliver,
    });
    if (sent && notices.length > 0) {
      this.intentHandler.markNoticesDelivered(
        conversationId,
        notices.map((notice) => notice.key),
      );
    }
    this.logger.log(
      formatTurnLine({
        correlationId: turnId,
        chat: maskChat(phoneNumber),
        route: slim ? `ia-reducida:${slim.intentKey}` : 'ia-completa',
        model: aiResult.modelUsed,
        llmCalls: aiResult.llmCalls,
        input: aiResult.usage
          ? aiResult.usage.input +
            aiResult.usage.cacheRead +
            aiResult.usage.cacheWrite
          : undefined,
        cacheRead: aiResult.usage?.cacheRead,
        cacheWrite: aiResult.usage?.cacheWrite,
        output: aiResult.usage?.output,
        ms: Date.now() - turnStartedAt,
        tools: toolTraces,
        flags: [
          ...(sent ? [] : ['descartada-desactualizada']),
          ...(guarded.replaced ? ['respuesta-reemplazada'] : []),
          ...(modelHandoff ? ['traspaso'] : []),
          ...(aiResult.stopReason === 'max_tokens' ? ['cortada'] : []),
          ...(toolTraces.some((t) => t.truncated)
            ? ['resultado-recortado']
            : []),
        ],
      }),
    );
    if (imageConsumed) {
      this.retainedImages.consume(conversationId);
      this.imagePrefetch.discard(conversationId);
    }
    const okTools = (aiResult.toolCallsExecuted ?? [])
      .filter((call) => call.ok)
      .map((call) => call.name);
    // Una respuesta descartada no avanza el flujo; lo que sí se ejecutó, sí cuenta.
    if (slim && (sent || okTools.length > 0)) {
      await this.intentHandler.afterSlimTurn(conversationId, slim, okTools);
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
      undefined,
      { mustDeliver: true },
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
      undefined,
      { mustDeliver: true },
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

  private async markFactConsumed(
    conversationId: string,
    capability: string,
    aiData: { context: ConversationContext },
  ): Promise<void> {
    const facts = markConsumed(aiData.context[FACTS_KEY], capability);
    if (!facts) return;
    aiData.context = { ...aiData.context, [FACTS_KEY]: facts };
    try {
      await this.conversationService.updateContext(conversationId, {
        contextPatch: { [FACTS_KEY]: facts },
      });
    } catch (error: unknown) {
      this.logger.warn(
        `No se pudo marcar la verificación como utilizada: ${maskSecrets(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }

  private async resolveImageBundle(
    message: WAMessage,
    job: ImageJob,
  ): Promise<ImageBundle> {
    const messageId = message.key.id;
    if (messageId) {
      const waitMs =
        this.imagePrefetch.downloadTimeoutMs() + MAX_TIMEOUT_MS + 3000;
      const taken = await this.imagePrefetch.take(
        job.conversationId,
        messageId,
        waitMs,
      );
      if (taken.status === 'READY' && taken.value.kind !== 'SKIPPED') {
        if (taken.waitedMs > 0) {
          this.logger.debug(
            `Análisis de imagen adelantado: se esperó ${taken.waitedMs} ms para completarlo.`,
          );
        }
        return taken.value;
      }
      if (taken.status === 'TIMEOUT') {
        this.logger.warn(
          `El análisis adelantado de la imagen no terminó tras ${taken.waitedMs} ms: se sigue sin analizarla.`,
        );
        return { kind: 'UNANALYZED' };
      }
    }
    return this.buildImageBundle({ ...job, message });
  }

  private async buildImageBundle(
    job: ImageJob & { message: WAMessage },
  ): Promise<ImageBundle> {
    const { message } = job;
    const bindings = await this.specialistRuntime.findBindings(
      job.tenantId,
      job.botConfigId,
    );
    const active = bindings.filter((binding) => binding.mode === 'ACTIVE');
    const shadow = bindings.filter((binding) => binding.mode === 'SHADOW');

    const legacyOnly = (): Promise<ImageBundle> => {
      this.countLegacyImage(job);
      return this.imageAnalysisService
        .analyzeFromMessage(message, job.botConfigId, job.systemPrompt)
        .then((result) => ({ kind: 'LEGACY' as const, result }));
    };

    if (bindings.length === 0) return legacyOnly();

    let original: Buffer;
    try {
      original = await new TurnBudget(
        this.imagePrefetch.downloadTimeoutMs(),
      ).race(this.imageAnalysisService.downloadOriginal(message));
    } catch {
      return active.length > 0 ? { kind: 'UNANALYZED' } : legacyOnly();
    }

    const prepared = prepareImage(original);
    prepared.catch(() => undefined);

    if (active.length === 0) {
      this.countLegacyImage(job);
      const legacy = this.imageAnalysisService.analyzeBuffer(
        original,
        job.botConfigId,
      );
      this.launchShadows(job, shadow, original, prepared, legacy);
      return { kind: 'LEGACY', result: await legacy };
    }

    this.launchShadows(job, shadow, original, prepared);

    const settled = await Promise.all(
      active.map(async (binding) => {
        try {
          const outcome = await this.specialistRuntime.run({
            tenantId: job.tenantId,
            botConfigId: job.botConfigId,
            conversationId: job.conversationId,
            capability: binding.capability,
            image: original,
            prepared,
            contactAddress: job.phoneNumber,
          });
          return { capability: binding.capability, outcome, failed: false };
        } catch (error: unknown) {
          this.logger.warn(
            `La verificación con especialista (${binding.capability}) falló: ${maskSecrets(error instanceof Error ? error.message : String(error))}`,
          );
          return {
            capability: binding.capability,
            outcome: null,
            failed: true,
          };
        }
      }),
    );

    const outcomes: CapabilityOutcome[] = [];
    for (const entry of settled) {
      if (entry.outcome?.executed) {
        outcomes.push({ ...entry.outcome, capability: entry.capability });
      }
    }
    for (const outcome of outcomes) this.alertPendingReview(job, outcome);

    if (outcomes.length > 0) return { kind: 'ACTIVE', outcomes };
    if (settled.some((entry) => entry.failed)) return { kind: 'UNANALYZED' };

    return {
      kind: 'LEGACY',
      result: await this.imageAnalysisService.analyzeBuffer(
        original,
        job.botConfigId,
      ),
    };
  }

  private alertPendingReview(job: ImageJob, outcome: CapabilityOutcome): void {
    const { result } = outcome;
    if (
      outcome.mode !== 'ACTIVE' ||
      outcome.capability !== IMAGE_ANALYSIS_CAPABILITY ||
      (result.verdict !== 'NEEDS_REVIEW' && result.verdict !== 'ERROR')
    ) {
      return;
    }
    try {
      void this.botEscalation
        .notifyVerificationReview({
          tenantId: job.tenantId,
          botConfigId: job.botConfigId,
          conversationId: job.conversationId,
          contactAddress: job.phoneNumber,
          verdict: result.verdict,
          reasonCodes: result.reasonCodes,
          recordId: outcome.recordId,
        })
        .catch(() => undefined);
    } catch {
      this.logger.warn(
        'No se pudo avisar de una imagen pendiente de revisión.',
      );
    }
  }

  private launchShadows(
    job: ImageJob,
    shadows: Array<{ capability: string }>,
    image: Buffer,
    prepared: Promise<PreparedImage>,
    legacyResult?: Promise<ImageAnalysisResult>,
  ): void {
    const verdict = legacyResult?.then(
      (result) =>
        result.status === 'SUCCESS'
          ? { valid: result.valid, confidence: result.confidence }
          : undefined,
      () => undefined,
    );
    for (const binding of shadows) {
      void this.specialistRuntime
        .run({
          tenantId: job.tenantId,
          botConfigId: job.botConfigId,
          conversationId: job.conversationId,
          capability: binding.capability,
          image,
          prepared,
          contactAddress: job.phoneNumber,
          ...(binding.capability === IMAGE_ANALYSIS_CAPABILITY && verdict
            ? { legacy: verdict }
            : {}),
        })
        .catch((error: unknown) => {
          this.logger.warn(
            `Especialista en SHADOW falló sin afectar la respuesta: ${maskSecrets(error instanceof Error ? error.message : String(error))}`,
          );
        });
    }
  }

  /** El conteo nunca puede afectar al turno. */
  private countLegacyImage(job: ImageJob): void {
    try {
      this.legacyUsage?.record(job.tenantId, job.botConfigId);
    } catch (error: unknown) {
      this.logger.warn(
        `No se pudo contar el uso del camino antiguo: ${maskSecrets(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }

  private warningOf(reason: ImageNotAnalyzedReason) {
    return { code: IMAGE_NOT_ANALYZED, reason, at: new Date().toISOString() };
  }

  /** Limpia la advertencia solo si había una, para no escribir de más. */
  private clearedWarning(ctx: {
    aiData: { context: ConversationContext };
  }): Record<string, null> {
    return ctx.aiData.context[IMAGE_WARNING_KEY]
      ? { [IMAGE_WARNING_KEY]: null }
      : {};
  }

  private async setImageWarning(
    ctx: { conversationId: string },
    warning: { reason: ImageNotAnalyzedReason },
  ): Promise<void> {
    try {
      await this.conversationService.updateContext(ctx.conversationId, {
        contextPatch: {
          [IMAGE_WARNING_KEY]: this.warningOf(warning.reason),
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        `No se pudo guardar la advertencia de imagen sin analizar: ${maskSecrets(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }

  private async applyImageBundle(
    bundle: ImageBundle,
    ctx: {
      conversationId: string;
      phoneNumber: string;
      aiData: { context: ConversationContext };
    },
  ): Promise<ImageApplication> {
    const unanalyzed: ImageApplication = {
      kind: 'CONTINUE',
      prefix: '[imagen recibida, no analizada]',
    };
    // Un fallo del análisis nunca corta el turno: la conversación sigue, la
    // imagen llega al panel como siempre y la conversación queda marcada con
    // una advertencia que el panel muestra.
    const notAnalyzed = async (
      reason: ImageNotAnalyzedReason,
    ): Promise<ImageApplication> => {
      await this.setImageWarning(ctx, { reason });
      return unanalyzed;
    };

    if (bundle.kind === 'UNANALYZED' || bundle.kind === 'SKIPPED') {
      return notAnalyzed('NOT_RUN');
    }

    if (bundle.kind === 'LEGACY') {
      const analysis = bundle.result;
      if (analysis.status === 'SUCCESS') {
        await this.conversationService.updateContext(ctx.conversationId, {
          contextPatch: {
            imageVerified: analysis.valid,
            lastImageDetails: analysis.details?.slice(0, 100),
            ...this.clearedWarning(ctx),
          },
        });
        return {
          kind: 'CONTINUE',
          imageVerified: analysis.valid,
          prefix: `[imagen: válida=${analysis.valid}, confianza=${analysis.confidence}${analysis.details ? `, ${analysis.details.slice(0, 80)}` : ''}]`,
        };
      }
      this.logger.warn(
        `Análisis de imagen no disponible (${analysis.status}) para ${ctx.phoneNumber}. Continuando sin contexto de imagen.`,
      );
      return notAnalyzed(
        analysis.status === 'PROVIDER_UNAVAILABLE'
          ? 'PROVIDER_UNAVAILABLE'
          : 'ANALYSIS_ERROR',
      );
    }

    let facts: unknown = ctx.aiData.context[FACTS_KEY];
    for (const outcome of bundle.outcomes) {
      facts = mergeFacts(
        facts,
        outcome.capability,
        buildFact(
          outcome.result,
          outcome.recordId,
          new Date(outcome.validUntil),
          outcome.exposedVariables,
        ),
      );
    }
    ctx.aiData.context = { ...ctx.aiData.context, [FACTS_KEY]: facts };

    const shown = shownOutcomes(bundle.outcomes);
    const verdicts = shown.map((outcome) => outcome.result.verdict);
    const imageVerified = verdicts.includes('INVALID')
      ? false
      : verdicts.every((verdict) => verdict === 'VALID')
        ? true
        : undefined;
    const hasError = verdicts.includes('ERROR');
    const details = shown
      .map((outcome) => outcome.result.humanSummary)
      .join(' | ')
      .slice(0, 100);

    try {
      await this.conversationService.updateContext(ctx.conversationId, {
        contextPatch: {
          [FACTS_KEY]: facts,
          ...(imageVerified !== undefined && { imageVerified }),
          lastImageDetails: details,
          ...(hasError
            ? { imageAnalysisWarning: this.warningOf('SPECIALIST_ERROR') }
            : this.clearedWarning(ctx)),
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        `No se pudo guardar el resultado de la verificación en la conversación: ${maskSecrets(error instanceof Error ? error.message : String(error))}`,
      );
    }

    const blocking = bundle.outcomes.find(
      (outcome) =>
        outcome.result.verdict === 'ERROR' && outcome.onFailure === 'BLOCK',
    );
    if (blocking) {
      this.logger.warn(
        `Verificación no disponible para ${ctx.phoneNumber} y el vínculo exige bloquear: se responde el texto de espera.`,
      );
      return {
        kind: 'REPLY',
        text: blocking.blockMessage ?? SPECIALIST_BLOCK_TEXT,
      };
    }

    const lines = shown.map((outcome) => {
      const codes =
        outcome.result.reasonCodes.length > 0
          ? `, ${outcome.result.reasonCodes.join(',')}`
          : '';
      const label =
        shown.length === 1 && outcome.capability === IMAGE_ANALYSIS_CAPABILITY
          ? ''
          : ` · ${outcome.capability}`;
      return `[imagen verificada por el sistema${label}: ${outcome.result.verdict}${codes}]`;
    });
    return { kind: 'CONTINUE', imageVerified, prefix: lines.join('\n') };
  }

  /**
   * Único punto por el que sale una respuesta del bot. Devuelve `false` si se
   * descartó por quedar desactualizada (el cliente escribió de nuevo): en ese
   * caso nada se guarda ni se envía, los mensajes siguen pendientes y la
   * siguiente pasada los contesta todos juntos con lo más reciente.
   */
  private async sendReply(
    turn: TurnContext,
    content: string,
    tokensUsed: number,
    imageVerified?: boolean,
    options: ReplyOptions = {},
  ): Promise<boolean> {
    if (isBlank(content)) {
      this.replyMetrics.increment('blockedEmpty');
      this.logger.error(
        `Se descartó un envío vacío para ${turn.phoneNumber}; no se manda nada al canal.`,
      );
      return false;
    }
    await this.readGates.get(turn.conversationId);

    if (!options.mustDeliver && (await this.isOutdated(turn))) {
      this.replyMetrics.increment('superseded');
      this.logger.log(
        `Respuesta a ${turn.phoneNumber} descartada: el cliente escribió de nuevo mientras se preparaba.`,
      );
      return false;
    }

    await this.eventBus.publishAsync(EVENT_TYPES.CHANNEL_SEND_REQUESTED, {
      phoneNumber: turn.phoneNumber,
      content,
      conversationId: turn.conversationId,
      connectionId: turn.connectionId,
      tenantId: turn.tenantId,
      tokensUsed,
      imageVerified,
      answeredUntil: turn.answeredUntil ?? null,
      supersedable: !options.mustDeliver,
    });
    return true;
  }

  /** Hora del último mensaje del cliente entre los pendientes. */
  private lastInboundAt(pending: Array<{ createdAt: Date }>): Date | null {
    return pending.reduce<Date | null>(
      (latest, m) => (!latest || m.createdAt > latest ? m.createdAt : latest),
      null,
    );
  }

  /**
   * ¿Esta respuesta ya quedó desactualizada? Lo está si el cliente escribió
   * algo después de lo que contesta. Si en este momento está escribiendo, se
   * espera (con tope) a ver si termina en un mensaje antes de decidir: así no
   * se responde dos veces ni se corrige sobre la marcha.
   */
  private async isOutdated(turn: TurnContext): Promise<boolean> {
    const deadline = Date.now() + this.TYPING_HOLD_MAX_MS;
    let held = false;
    for (;;) {
      if (
        await this.conversationService.hasNewInboundSince(
          turn.conversationId,
          turn.answeredUntil,
        )
      ) {
        return true;
      }
      if (this.receiptTracker.isTyping(turn.sessionKey)) {
        if (Date.now() >= deadline) return false;
        held = true;
        await this.sleep(this.TYPING_POLL_MS);
        continue;
      }
      if (held) {
        // Acaba de dejar de escribir: puede retomar o enviar enseguida.
        held = false;
        await this.sleep(this.TYPING_SETTLE_MS);
        continue;
      }
      return false;
    }
  }

  /**
   * El cliente escribió de nuevo: las respuestas de esta conversación que aún
   * no salieron quedan desactualizadas. Se descartan ya, para que la IA no las
   * dé por dichas y la próxima respuesta cubra todo lo que el cliente pidió.
   */
  private async discardOutdatedReplies(
    conversationId: string,
    phoneNumber: string,
  ): Promise<void> {
    if (!this.outbox) return;
    try {
      const discarded = await this.outbox.supersedeUnsent(conversationId);
      if (discarded > 0) {
        this.replyMetrics.increment('superseded');
        this.logger.log(
          `${phoneNumber} escribió de nuevo: ${discarded} respuesta(s) sin enviar descartada(s).`,
        );
      }
    } catch (error) {
      // Si falla, la respuesta sale como antes y el mensaje nuevo se contesta después.
      this.logger.warn(
        `No se pudieron descartar las respuestas pendientes de ${phoneNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
    pin = false,
  ): Promise<void> {
    try {
      await this.conversationService.appendActionMemory(
        conversationId,
        {
          herramienta: req.name,
          parametros: this.compactJson(req.arguments, 200),
          estado: outcome.status,
          resultado:
            outcome.status === 'SUCCESS'
              ? this.compactJson(outcome.responseBody, 600)
              : (outcome.errorDetail ??
                this.compactJson(outcome.responseBody, 300)),
          en: new Date().toISOString(),
        },
        { pin },
      );
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

    const teamNotified = recorded.some((call) => call.teamNotified === true);
    if (!modelHandoff && !teamNotified && promisesHumanContact(input.content)) {
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

  private async silenceTurn(
    conversationId: string,
    pending: Array<{ id: string; content: string; hasImage: boolean }>,
    handoffQuiet: boolean,
  ): Promise<void> {
    await this.conversationService.ignorePending(pending.map((m) => m.id));
    if (handoffQuiet) return;
    const text = pending
      .filter((m) => !m.hasImage)
      .map((m) => m.content)
      .join('\n');
    if (text.trim() === '') return;
    await this.conversationService.updateContext(conversationId, {
      contextPatch: personalChatPatch(text),
    });
  }

  private async humanTakeoverEndsAt(
    botConfigId: string,
    phoneNumber: string,
    takeoverMinutes: number,
  ): Promise<Date | null> {
    const takeoverMs = takeoverMinutes * 60 * 1000;
    const cutoff = new Date(Date.now() - takeoverMs);

    const lastHumanMessage =
      await this.conversationService.findLastHumanMessage(
        botConfigId,
        phoneNumber,
        cutoff,
      );

    return lastHumanMessage
      ? new Date(lastHumanMessage.createdAt.getTime() + takeoverMs)
      : null;
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
const ACTION_PROPOSAL =
  /\b(?:confirm|agend|apart|reserv|separ|cancel|reagend|registr)/i;

const slotConfirmedInstruction = (said: string) =>
  `ATENCIÓN: la clienta aceptó («${said.slice(0, 200)}») el día y la hora que le propusiste. Ejecuta ahora la acción con la herramienta que corresponde (crear la reserva o reagendar) usando los datos que ya están en la conversación. No vuelvas a consultar listas ni disponibilidad, no pidas otra confirmación y no anuncies que vas a verificar: responde según el resultado real de la herramienta.`;

const RECONFIRMATION =
  /\b(?:te (?:funciona|sirve|queda|parece)|est[aá] bien|de acuerdo|correcto|seguro|lo dejamos|la dejamos)\b/i;

const UNCONFIRMED_ACTION_TEXT =
  'Perdona, no alcancé a completarlo. ¿Me confirmas de nuevo para intentarlo?';

const COMPLETED_WORD =
  /\b(?:agendad[ao]|reservad[ao]|apartad[ao]|separad[ao]|cancelad[ao]|reagendad[ao]|confirmad[ao]|registrad[ao]|cread[ao])\b|\bse (?:agend[oó]|reserv[oó]|cancel[oó]|reagend[oó]|registr[oó]|cre[oó])\b/i;

function claimsCompleted(text: string): boolean {
  return COMPLETED_CLAIM.test(text) && COMPLETED_WORD.test(text);
}
