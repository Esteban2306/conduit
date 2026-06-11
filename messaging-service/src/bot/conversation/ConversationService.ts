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

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  private readonly LOCK_TIMEOUT_MS = 30000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBusService,
  ) {}

  async getOrCreate(dto: CreateConversationDto) {
    const existing = await this.prisma.conversation.findFirst({
      where: {
        botConfigId: dto.botConfigId,
        phoneNumber: dto.phoneNumber,
        status: ConversationStatus.ACTIVE,
      },
    });

    if (existing) {
      return existing;
    }

    this.logger.log(
      `Nueva conversación: ${dto.phoneNumber} → bot ${dto.botConfigId}`,
    );

    const conversation = await this.prisma.conversation.create({
      data: {
        tenantId: dto.tenantId,
        botConfigId: dto.botConfigId,
        phoneNumber: dto.phoneNumber,
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
        lastMessageAt: true,
        createdAt: true,
        _count: { select: { messages: true } },
      },
    });
  }

  touchActivity(conversationId: string) {
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date(), updatedAt: new Date() },
    });
  }

  async saveInbound(conversationId: string, content: string, hasImage = false) {
    const [, message] = await this.prisma.$transaction([
      this.touchActivity(conversationId),

      this.prisma.botMessage.create({
        data: {
          conversationId,
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
    },
  ) {
    const [, message] = await this.prisma.$transaction([
      this.touchActivity(conversationId),
      this.prisma.botMessage.create({
        data: {
          conversationId,
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

  async getConversationForAI(conversationId: string, maxMessages: number) {
    const conversation = await this.findById(conversationId);

    const messages = await this.prisma.botMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: maxMessages,
      select: {
        direction: true,
        content: true,
        intent: true,
      },
    });

    const history: HistoryMessage[] = messages.reverse().map((msg) => ({
      role:
        msg.direction === MessageDirection.INBOUND
          ? MessageRole.USER
          : MessageRole.ASSISTANT,
      content: msg.content,
    }));

    return {
      context: conversation.context as ConversationContext,
      currentStep: conversation.currentStep,
      lastIntent: conversation.lastIntent,
      history,
    };
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

    const conversation = this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        status,
        updatedAt: new Date(),
        lockedUntil: null,
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

  async acquireLock(conversationId: string): Promise<Boolean> {
    const now = new Date();

    const lockExpiry = new Date(now.getTime() + this.LOCK_TIMEOUT_MS);

    const result = await this.prisma.conversation.updateMany({
      where: {
        id: conversationId,
        OR: [{ processing: false }, { lockedUntil: { lt: now } }],
      },
      data: {
        processing: true,
        lockedUntil: lockExpiry,
      },
    });

    return result.count > 0;
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
}
