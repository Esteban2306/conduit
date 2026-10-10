import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';
import { CreateConversationDto } from './dto/CreateConversation.dto';
import { ConversationStatus, Prisma } from '@prisma/client';
import { MessageDirection, MessageRole } from './types/MessageRole';
import {
  HistoryMessage,
  ConversationHistory,
} from './interfaces/ConversationHistory';
import { ConversationContext } from './interfaces/ConversationContext';
import { UpdateContextDto } from './dto/UpdateContext.dto';
import { EventBusService } from 'src/infra/events/event.service';
import { EVENT_TYPES } from 'src/infra/events/constants/event.types';

const CLOSED_STATUSES: ConversationStatus[] = [
  ConversationStatus.COMPLETED,
  ConversationStatus.ABANDONED,
];

function closedAtOf(context: ConversationContext | null): Date | null {
  const value = context?.closedAt;
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Mínimo de mensajes recientes que el modelo ve completos. */
export const MIN_HISTORY_WINDOW = 12;
/** Recorte por mensaje: suficiente para listas de horarios o precios. */
const MAX_MESSAGE_CHARS = 1500;
/** Acciones (llamadas a herramientas) que se recuerdan por conversación. */
const MAX_ACTION_MEMORY = 8;

export interface ActionMemoryEntry {
  herramienta: string;
  parametros: string;
  estado: string;
  resultado: string;
  en: string;
}

export interface ConversationForAI {
  context: ConversationContext;
  currentStep: string | null;
  lastIntent: string | null;
  /** Mensajes ya respondidos, en orden, empezando por un turno del cliente. */
  history: HistoryMessage[];
  /** Mensajes del negocio previos al primer turno del cliente en la ventana. */
  leadingBotMessages: string[];
  /** Lo que el cliente escribió desde la última respuesta: lo que hay que responder. */
  pending: { id: string; content: string; hasImage: boolean }[];
  summary: string | null;
}

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  private readonly LOCK_TIMEOUT_MS = 30000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBusService,
  ) {}

  async getOrCreate(dto: CreateConversationDto) {
    // (botConfigId, phoneNumber) es único: una conversación cerrada se
    // reabre en vez de intentar crear otra (que fallaría por la restricción).
    const existing = await this.prisma.conversation.findFirst({
      where: {
        botConfigId: dto.botConfigId,
        phoneNumber: dto.phoneNumber,
      },
    });

    if (existing) {
      if (existing.status === ConversationStatus.ACTIVE) return existing;
      return this.prisma.conversation.update({
        where: { id: existing.id },
        data: {
          status: ConversationStatus.ACTIVE,
          lastMessageAt: new Date(),
          ...(dto.connectionId && { lastConnectionId: dto.connectionId }),
        },
      });
    }

    this.logger.log(
      `Nueva conversación: ${dto.phoneNumber} → bot ${dto.botConfigId}`,
    );

    const conversation = await this.prisma.conversation.create({
      data: {
        tenantId: dto.tenantId,
        botConfigId: dto.botConfigId,
        phoneNumber: dto.phoneNumber,
        lastConnectionId: dto.connectionId ?? null,
        status: ConversationStatus.ACTIVE,
        context: (dto.initialContext ?? {}) as Prisma.InputJsonValue,
        lastMessageAt: new Date(),
      },
    });

    this.eventBus.publish(
      EVENT_TYPES.CONVERSATION_CREATED,
      {
        conversationId: conversation.id,
        botConfigId: conversation.botConfigId,
        tenantId: conversation.tenantId,
        phoneNumber: conversation.phoneNumber,
      },
      {
        tenantId: conversation.tenantId,
      },
    );

    return conversation;
  }

  async findLastHumanMessage(
    botConfigId: string,
    phoneNumber: string,
    since: Date,
  ): Promise<{ id: string } | null> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { botConfigId, phoneNumber },
      orderBy: { createdAt: 'desc' },
      select: { id: true, context: true },
    });

    if (!conversation) return null;

    const closedAt = closedAtOf(conversation.context as ConversationContext);

    return this.prisma.botMessage.findFirst({
      where: {
        conversationId: conversation.id,
        direction: 'OUTBOUND',
        processedBy: 'human',
        createdAt: { gte: closedAt && closedAt > since ? closedAt : since },
      },
      select: { id: true },
    });
  }

  async saveHumanOutbound(
    conversationId: string,
    content: string,
    connectionId?: string,
  ) {
    const [, message] = await this.prisma.$transaction([
      this.touchActivity(conversationId, connectionId),
      this.prisma.botMessage.create({
        data: {
          conversationId,
          connectionId: connectionId ?? null,
          direction: MessageDirection.OUTBOUND,
          content,
          processedBy: 'human',
        },
      }),
    ]);

    return message;
  }

  async findById(id: string) {
    const conv = await this.prisma.conversation.findUnique({
      where: { id },
    });

    if (!conv) throw new NotFoundException(`Conversación ${id} no encontrada`);
    return conv;
  }

  async findActiveByPhone(botConfigId: string, phoneNumber: string) {
    return this.prisma.conversation.findFirst({
      where: {
        botConfigId,
        phoneNumber,
        status: ConversationStatus.ACTIVE,
      },
    });
  }

  async findAllByBot(botConfigId: string, status?: ConversationStatus) {
    return this.prisma.conversation.findMany({
      where: {
        botConfigId,
        ...(status && { status }),
      },
      orderBy: { lastMessageAt: 'desc' },
      select: {
        id: true,
        phoneNumber: true,
        status: true,
        context: true,
        lastConnectionId: true,
        lastMessageAt: true,
        createdAt: true,
        _count: { select: { messages: true } },
      },
    });
  }

  touchActivity(conversationId: string, connectionId?: string) {
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: new Date(),
        updatedAt: new Date(),
        ...(connectionId && { lastConnectionId: connectionId }),
      },
    });
  }

  async saveInbound(
    conversationId: string,
    content: string,
    hasImage = false,
    connectionId?: string,
  ) {
    const [, message] = await this.prisma.$transaction([
      this.touchActivity(conversationId, connectionId),

      this.prisma.botMessage.create({
        data: {
          conversationId,
          connectionId: connectionId ?? null,
          direction: MessageDirection.INBOUND,
          content,
          hasImage,
          processedBy: 'user',
        },
      }),
    ]);

    this.eventBus.publish(EVENT_TYPES.MESSAGE_RECEIVED, {
      conversationId,
      messageId: message.id,
      content,
      hasImage,
    });

    return message;
  }

  async saveOutbound(
    conversationId: string,
    content: string,
    options?: {
      intent?: string;
      tokensUsed?: number;
      imageVerified?: boolean;
      connectionId?: string;
    },
  ) {
    const [, message] = await this.prisma.$transaction([
      this.touchActivity(conversationId, options?.connectionId),
      this.prisma.botMessage.create({
        data: {
          conversationId,
          connectionId: options?.connectionId ?? null,
          direction: MessageDirection.OUTBOUND,
          content,
          processedBy: 'bot',
          intent: options?.intent,
          tokenUsed: options?.tokensUsed,
          imageVerfied: options?.imageVerified,
        },
      }),
    ]);

    this.eventBus.publish(EVENT_TYPES.MESSAGE_GENERATED, {
      conversationId,
      messageId: message.id,
      content,
      intent: options?.intent,
    });

    return message;
  }

  /**
   * Arma la memoria que ve el modelo:
   * - `pending`: todo lo que el cliente escribió desde la última respuesta
   *   (lo que hay que contestar ahora; nunca se pierde aunque llegue en
   *   varios lotes o mientras el bot estaba ocupado).
   * - `history`: los últimos mensajes ya respondidos, completos.
   * - `summary` y `context.memoriaAcciones`: lo anterior a la ventana y los
   *   resultados reales de las herramientas, para no perder el objetivo.
   */
  async getConversationForAI(
    conversationId: string,
    maxMessages: number,
  ): Promise<ConversationForAI> {
    const conversation = await this.findById(conversationId);
    const window = Math.max(maxMessages ?? 0, MIN_HISTORY_WINDOW);

    const recent = (
      await this.prisma.botMessage.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        take: window + 30,
        select: {
          id: true,
          direction: true,
          content: true,
          hasImage: true,
          createdAt: true,
        },
      })
    ).reverse();
    const closedAt = closedAtOf(conversation.context as ConversationContext);

    let lastOutbound = -1;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].direction === MessageDirection.OUTBOUND) {
        lastOutbound = i;
        break;
      }
    }

    const pending = recent
      .slice(lastOutbound + 1)
      .filter(
        (m) =>
          m.direction === MessageDirection.INBOUND &&
          (!closedAt || m.createdAt > closedAt),
      )
      .map((m) => ({ id: m.id, content: m.content, hasImage: m.hasImage }));

    const answered = recent.slice(0, lastOutbound + 1).slice(-window);
    const merged = this.mergeConsecutive(
      answered.map((msg) => ({
        role:
          msg.direction === MessageDirection.INBOUND
            ? MessageRole.USER
            : MessageRole.ASSISTANT,
        content: this.truncateChars(msg.content, MAX_MESSAGE_CHARS),
      })),
    );

    // Algunos proveedores exigen que el historial empiece por el cliente
    // (Gemini descarta lo anterior, Anthropic lo rechaza): los mensajes del
    // negocio que quedan al inicio (p. ej. un recordatorio) se pasan aparte
    // para que el bot sepa qué está contestando el cliente.
    const leadingBotMessages: string[] = [];
    while (merged.length > 0 && merged[0].role === MessageRole.ASSISTANT) {
      leadingBotMessages.push(merged.shift()!.content);
    }

    return {
      context: (conversation.context ?? {}) as ConversationContext,
      currentStep: conversation.currentStep,
      lastIntent: conversation.lastIntent,
      history: merged,
      leadingBotMessages,
      pending,
      summary: conversation.summary,
    };
  }

  /**
   * Pausa el bot en una conversación (traspaso a una persona, abuso, IA
   * caída). Los mensajes del cliente se siguen guardando; al reanudar, el
   * bot responde lo pendiente.
   */
  async pauseBot(
    conversationId: string,
    minutes: number,
    reason: string,
  ): Promise<Date> {
    const until = new Date(Date.now() + minutes * 60_000);
    await this.updateContext(conversationId, {
      contextPatch: {
        botPausedUntil: until.toISOString(),
        botPauseReason: reason,
      },
    });
    return until;
  }

  async resumeBot(conversationId: string): Promise<void> {
    await this.updateContext(conversationId, {
      contextPatch: { botPausedUntil: null, botPauseReason: null },
    });
  }

  isBotPaused(context: ConversationContext): boolean {
    const until = context.botPausedUntil;
    return typeof until === 'string' && new Date(until).getTime() > Date.now();
  }

  async countBotRepliesSince(
    conversationId: string,
    since: Date,
  ): Promise<number> {
    return this.prisma.botMessage.count({
      where: {
        conversationId,
        direction: MessageDirection.OUTBOUND,
        processedBy: 'bot',
        createdAt: { gte: since },
      },
    });
  }

  /** Listado paginado para el panel. */
  async listForAdmin(
    botConfigId: string,
    options: {
      status?: ConversationStatus;
      search?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const page = Math.max(options.page ?? 1, 1);
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const where: Prisma.ConversationWhereInput = {
      botConfigId,
      ...(options.status && { status: options.status }),
      ...(options.search && { phoneNumber: { contains: options.search } }),
    };

    const [rows, total] = await Promise.all([
      this.prisma.conversation.findMany({
        where,
        orderBy: { lastMessageAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          phoneNumber: true,
          status: true,
          context: true,
          summary: true,
          lastConnectionId: true,
          lastMessageAt: true,
          createdAt: true,
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { direction: true, content: true, processedBy: true },
          },
        },
      }),
      this.prisma.conversation.count({ where }),
    ]);

    const data = rows.map(({ context, messages, ...row }) => {
      const ctx = (context ?? {}) as ConversationContext;
      return {
        ...row,
        botPaused: this.isBotPaused(ctx),
        botPausedUntil: this.isBotPaused(ctx) ? ctx.botPausedUntil : null,
        botPauseReason: this.isBotPaused(ctx) ? ctx.botPauseReason : null,
        lastMessage: messages[0] ?? null,
        // Esperando respuesta: el último mensaje es del cliente.
        awaitingReply:
          !CLOSED_STATUSES.includes(row.status) &&
          messages[0]?.direction === MessageDirection.INBOUND,
      };
    });

    return { data, meta: { total, page, limit } };
  }

  async getMessagesPage(
    conversationId: string,
    options: { before?: Date; limit?: number },
  ) {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = await this.prisma.botMessage.findMany({
      where: {
        conversationId,
        ...(options.before && { createdAt: { lt: options.before } }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        direction: true,
        content: true,
        hasImage: true,
        processedBy: true,
        createdAt: true,
      },
    });
    return rows.reverse();
  }

  /** Último mensaje enviado al cliente (bot, humano o proactivo). */
  async lastOutboundContent(
    botConfigId: string,
    phoneNumber: string,
  ): Promise<string | null> {
    const message = await this.prisma.botMessage.findFirst({
      where: {
        direction: MessageDirection.OUTBOUND,
        conversation: { botConfigId, phoneNumber },
      },
      orderBy: { createdAt: 'desc' },
      select: { content: true },
    });
    return message?.content ?? null;
  }

  /**
   * Guarda en la memoria de la conversación el resultado real de una
   * herramienta. Debe llamarse con el lock de la conversación tomado.
   */
  async appendActionMemory(
    conversationId: string,
    entry: ActionMemoryEntry,
  ): Promise<void> {
    const context = await this.getContext(conversationId);
    const previous = Array.isArray(context.memoriaAcciones)
      ? (context.memoriaAcciones as ActionMemoryEntry[])
      : [];

    await this.updateContext(conversationId, {
      contextPatch: {
        memoriaAcciones: [...previous, entry].slice(-MAX_ACTION_MEMORY),
      },
    });
  }

  /**
   * Mensajes que salieron de la ventana del historial y aún no están en el
   * resumen. Devuelve vacío mientras no haya suficientes para resumir.
   */
  async getMessagesToSummarize(
    conversationId: string,
    maxMessages: number,
    minBatch = 6,
  ): Promise<{ lines: string[]; upTo: Date } | null> {
    const conversation = await this.findById(conversationId);
    const window = Math.max(maxMessages ?? 0, MIN_HISTORY_WINDOW);
    const context = (conversation.context ?? {}) as ConversationContext;
    const coveredUntil =
      typeof context.resumenHasta === 'string'
        ? new Date(context.resumenHasta)
        : new Date(0);

    const candidates = await this.prisma.botMessage.findMany({
      where: { conversationId, createdAt: { gt: coveredUntil } },
      orderBy: { createdAt: 'asc' },
      select: { direction: true, content: true, createdAt: true },
    });

    const outsideWindow = candidates.slice(
      0,
      Math.max(0, candidates.length - window),
    );
    if (outsideWindow.length < minBatch) return null;

    return {
      lines: outsideWindow.map(
        (m) =>
          `${m.direction === MessageDirection.INBOUND ? 'Cliente' : 'Negocio'}: ${this.truncateChars(m.content, 500)}`,
      ),
      upTo: outsideWindow[outsideWindow.length - 1].createdAt,
    };
  }

  async saveSummary(
    conversationId: string,
    summary: string,
    upTo: Date,
  ): Promise<void> {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { summary },
    });
    await this.updateContext(conversationId, {
      contextPatch: { resumenHasta: upTo.toISOString() },
    });
  }

  /**
   * Registra en la conversación un mensaje que el negocio envió por fuera
   * del bot (recordatorio, aviso). Así, cuando el cliente responda "sí" o
   * "quiero reagendar", el bot sabe a qué está respondiendo.
   */
  async recordProactiveOutbound(params: {
    tenantId: string;
    botConfigId: string;
    phoneNumber: string;
    connectionId: string;
    content: string;
  }): Promise<void> {
    const conversation = await this.getOrCreate({
      tenantId: params.tenantId,
      botConfigId: params.botConfigId,
      phoneNumber: params.phoneNumber,
      connectionId: params.connectionId,
    });

    await this.prisma.$transaction([
      this.touchActivity(conversation.id, params.connectionId),
      this.prisma.botMessage.create({
        data: {
          conversationId: conversation.id,
          connectionId: params.connectionId,
          direction: MessageDirection.OUTBOUND,
          content: params.content,
          processedBy: 'system',
        },
      }),
    ]);
  }

  private mergeConsecutive(messages: HistoryMessage[]): HistoryMessage[] {
    const merged: HistoryMessage[] = [];
    for (const msg of messages) {
      const last = merged[merged.length - 1];
      if (last && last.role === msg.role) {
        if (
          this.normalizeContent(last.content) !==
          this.normalizeContent(msg.content)
        ) {
          last.content = `${last.content}\n${msg.content}`;
        }
      } else {
        merged.push({ ...msg });
      }
    }
    return merged;
  }

  private truncateChars(content: string, maxChars: number): string {
    if (content.length <= maxChars) return content;
    return content.slice(0, maxChars) + '…';
  }

  async getHistory(
    conversationId: string,
    maxMessage: number,
  ): Promise<ConversationHistory> {
    const conversation = await this.findById(conversationId);

    const rawMessage = await this.prisma.botMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: maxMessage,
      select: {
        direction: true,
        content: true,
      },
    });

    const totalMessages = await this.prisma.botMessage.count({
      where: { conversationId },
    });

    const messages: HistoryMessage[] = rawMessage.reverse().map((msg) => ({
      role:
        msg.direction === MessageDirection.INBOUND
          ? MessageRole.USER
          : MessageRole.ASSISTANT,
      content: msg.content,
    }));

    return {
      conversationId,
      phoneNumber: conversation.phoneNumber,
      messages,
      context: conversation.context as Record<string, unknown>,
      totalMessages,
    };
  }

  async getContext(conversationId: string): Promise<ConversationContext> {
    const conv = await this.findById(conversationId);
    return (conv.context ?? {}) as ConversationContext;
  }

  async updateContext(
    conversationId: string,
    dto: UpdateContextDto,
  ): Promise<void> {
    const patch = dto.contextPatch ?? {};

    const affectedRows = await this.prisma.$executeRaw`
    UPDATE "Conversation"
    SET
      context =
        COALESCE(context::jsonb, '{}'::jsonb)
        || ${JSON.stringify(patch)}::jsonb,

      "lastIntent" =
        COALESCE(${dto.intent ?? null}, "lastIntent"),

      "currentStep" =
        COALESCE(${dto.step ?? null}, "currentStep"),

      "updatedAt" = NOW()

    WHERE id = ${conversationId}
  `;

    this.eventBus.publish(EVENT_TYPES.CONTEXT_UPDATED, {
      conversationId,
      step: dto.step,
      intent: dto.intent,
    });

    if (affectedRows === 0) {
      throw new NotFoundException(
        `Conversación ${conversationId} no encontrada`,
      );
    }
  }

  async resetContext(conversationId: string) {
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        context: {},
        updatedAt: new Date(),
      },
    });
  }

  async close(conversationId: string, status: ConversationStatus) {
    const validClosingStatuses: ConversationStatus[] = [
      ConversationStatus.COMPLETED,
      ConversationStatus.ABANDONED,
    ];

    if (!validClosingStatuses.includes(status)) {
      throw new BadRequestException(`Estado de cierre inválido: ${status}`);
    }

    this.logger.log(`Cerrando conversación ${conversationId} → ${status}`);

    const conversation = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        status,
        updatedAt: new Date(),
        lockedUntil: null,
      },
    });

    await this.updateContext(conversationId, {
      contextPatch: {
        closedAt: new Date().toISOString(),
        botPausedUntil: null,
        botPauseReason: null,
      },
    });

    this.eventBus.publish(EVENT_TYPES.CONVERSATION_CLOSED, {
      conversationId,
      status,
    });

    return conversation;
  }

  async updateSummary(conversationId: string, summary: string) {
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        summary,
        updatedAt: new Date(),
      },
    });
  }

  async setWaitingPayment(conversationId: string) {
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        status: ConversationStatus.WAITING_PAYMENT,
        updatedAt: new Date(),
      },
    });
  }

  async reopen(botConfigId: string, phoneNumber: string) {
    const conv = await this.prisma.conversation.findFirst({
      where: { botConfigId, phoneNumber },
      orderBy: { createdAt: 'desc' },
    });

    if (!conv) return null;

    this.logger.log(`Reabriendo conversación: ${phoneNumber}`);

    return this.prisma.conversation.update({
      where: { id: conv.id },
      data: {
        status: ConversationStatus.ACTIVE,
        lastMessageAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  async closeExpired(
    botConfigId: string,
    timeoutMinutes: number,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);

    const result = await this.prisma.conversation.updateMany({
      where: {
        botConfigId,
        status: ConversationStatus.ACTIVE,
        lastMessageAt: { lt: cutoff },
      },
      data: {
        status: ConversationStatus.ABANDONED,
        updatedAt: new Date(),
      },
    });

    if (result.count > 0) {
      this.logger.log(
        `Cerradas ${result.count} conversaciones expiradas (bot: ${botConfigId}, timeout: ${timeoutMinutes}min)`,
      );
    }

    return result.count;
  }

  async getStats(botConfigId: string) {
    const [active, waitingPayment, completed, abandoned] = await Promise.all([
      this.prisma.conversation.count({
        where: { botConfigId, status: ConversationStatus.ACTIVE },
      }),
      this.prisma.conversation.count({
        where: { botConfigId, status: ConversationStatus.WAITING_PAYMENT },
      }),
      this.prisma.conversation.count({
        where: { botConfigId, status: ConversationStatus.COMPLETED },
      }),
      this.prisma.conversation.count({
        where: { botConfigId, status: ConversationStatus.ABANDONED },
      }),
    ]);

    return { active, waitingPayment, completed, abandoned };
  }

  async acquireLock(conversationId: string): Promise<boolean> {
    try {
      const result = await this.prisma.$executeRaw`
      UPDATE "Conversation"
      SET 
        processing = true,
        "lockedUntil" = NOW() + INTERVAL '120 seconds',
        "updatedAt" = NOW()
      WHERE 
        id = ${conversationId}
        AND (processing = false OR "lockedUntil" < NOW())
    `;
      return result > 0;
    } catch {
      return false;
    }
  }

  async releaseLock(conversationId: string): Promise<void> {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        processing: false,
        lockedUntil: null,
      },
    });
  }

  async isLocked(conversationId: string): Promise<boolean> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { processing: true, lockedUntil: true },
    });
    if (!conv) return false;
    if (!conv.processing) return false;
    if (conv.processing && conv.lockedUntil && conv.lockedUntil < new Date()) {
      await this.releaseLock(conversationId);
      return false;
    }
    return true;
  }

  // ejecutar cada minuto con cron por si la conversacion muere
  async releaseExpiredLocks(): Promise<number> {
    const result = await this.prisma.conversation.updateMany({
      where: {
        processing: true,
        lockedUntil: {
          lt: new Date(),
        },
      },
      data: {
        processing: false,
        lockedUntil: null,
      },
    });

    return result.count;
  }

  private normalizeContent(content: string): string {
    return content.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
  }
}
