import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageChannel, MessageStatus, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { MessageJobPayload, QUEUE_NAMES } from 'src/queue/queues';
import { PrismaService } from 'src/shared/prisma.service';
import { TemplateService } from '../templates/TemplateService';
import { DataAdapterValidator } from '../adapters/DataAdapterValidator';
import { MessagePayload } from '../adapters/IDataAdapter';

@Injectable()
export class MessageOrchestrator {
  private readonly logger = new Logger(MessageOrchestrator.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.MESSAGES)
    private readonly messageQueue: Queue<MessageJobPayload>,
    @InjectQueue(QUEUE_NAMES.MESSAGES_SCHEDULED)
    private readonly scheduledQueue: Queue<MessageJobPayload>,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly templateService: TemplateService,
  ) {}

  async dispatch(raw: unknown): Promise<{ messageId: string; status: string }> {
    const payload = DataAdapterValidator.validate(raw);

    if (payload.template.id) {
      await this.validateTemplate(payload.template.id);
    }

    this.validateChannel(payload.recipient.channel);

    const tenantId = this.config.get<string>('tenant.defaultId') ?? 'default';

    const scheduledAt = payload.options?.scheduledAt
      ? new Date(payload.options.scheduledAt)
      : new Date();

    const message = await this.prisma.message.create({
      data: {
        tenantId,
        channel: payload.recipient.channel as MessageChannel,
        recipient: payload.recipient.address,
        templateId: payload.template.id ?? null,
        variables: (payload.variables ?? {}) as Prisma.InputJsonValue,
        meta: payload.meta
          ? (payload.meta as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        status: MessageStatus.PENDING,
        scheduledAt,
        maxAttempts: this.config.get<number>('queue.maxAttempts') ?? 5,
        renderedSubject: payload.template.inline?.subject ?? '',
        renderedBody: payload.template.inline?.body ?? '',
      },
    });

    const jobPayload: MessageJobPayload = {
      messageId: message.id,
      tenantId,
      channel: payload.recipient.channel,
      recipient: payload.recipient.address,
      templateId: payload.template.id ?? '',
      inlineBody: payload.template.inline?.body ?? '',
      inlineSubject: payload.template.inline?.subject ?? '',
      variables: payload.variables ?? {},
      meta: payload.meta,
      sheduledAt: payload.options?.scheduledAt,
    };

    const jobOptions = this.buildJobOptions(payload, scheduledAt);
    const isScheduled = scheduledAt.getTime() - Date.now() > 1000;

    const targetQueue = isScheduled ? this.scheduledQueue : this.messageQueue;

    const job = await targetQueue.add(
      `message:${payload.recipient.channel}`,
      { ...jobPayload, isScheduled },
      jobOptions,
    );

    await this.prisma.message.update({
      where: { id: message.id },
      data: { status: MessageStatus.QUEUED },
    });

    this.logger.log(
      `Mensaje encolado: ${message.id} | Canal: ${payload.recipient.channel} | Job: ${job.id}`,
    );

    return {
      messageId: message.id,
      status: MessageStatus.QUEUED,
    };
  }

  async dispatchBatch(raws: unknown[]): Promise<{
    total: number;
    queued: number;
    failed: Array<{ index: number; error: string }>;
  }> {
    const results = await Promise.allSettled(
      raws.map((raw) => this.dispatch(raw)),
    );

    const failed: Array<{ index: number; error: string }> = [];
    let queued = 0;

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        queued++;
      } else {
        failed.push({
          index,
          error: result.reason?.message ?? 'Error desconocido',
        });
      }
    });

    this.logger.log(`Batch despachado: ${queued}/${raws.length} encolados`);

    return { total: raws.length, queued, failed };
  }

  async getStatus(messageId: string) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: {
        attemptLogs: { orderBy: { createdAt: 'desc' } },
        deadLetter: true,
      },
    });

    if (!message) {
      throw new NotFoundException(`Mensaje ${messageId} no encontrado`);
    }

    return {
      messageId: message.id,
      channel: message.channel,
      recipient: message.recipient,
      status: message.status,
      attempts: message.attempts,
      maxAttempts: message.maxAttempts,
      scheduledAt: message.scheduledAt,
      sentAt: message.sentAt,
      resolvedAt: message.resolvedAt,
      provider: message.provider,
      providerMessageId: message.providerMessageId,
      lastError: message.lastError,
      retryable: message.retryable,
      attemptLogs: message.attemptLogs,
      deadLetter: message.deadLetter ?? null,
    };
  }

  async cancel(
    messageId: string,
  ): Promise<{ messageId: string; status: string }> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
    });

    if (!message) {
      throw new NotFoundException(`Mensaje ${messageId} no encontrado`);
    }

    const cancellable: MessageStatus[] = [
      MessageStatus.PENDING,
      MessageStatus.QUEUED,
      MessageStatus.FAILED,
    ];

    if (!cancellable.includes(message.status as MessageStatus)) {
      throw new BadRequestException(
        `El mensaje en estado ${message.status} no puede cancelarse`,
      );
    }

    const jobs = await this.messageQueue.getJobs(['waiting', 'delayed']);
    const job = jobs.find((j) => j.data.messageId === messageId);
    if (job) await job.remove();

    await this.prisma.message.update({
      where: { id: messageId },
      data: {
        status: MessageStatus.CANCELLED,
        resolvedAt: new Date(),
      },
    });

    this.logger.log(`Mensaje cancelado: ${messageId}`);

    return { messageId, status: MessageStatus.CANCELLED };
  }

  private async validateTemplate(templateId: string): Promise<void> {
    try {
      await this.templateService.findOne(templateId);
    } catch {
      throw new NotFoundException(
        `Template ${templateId} no encontrado o inactivo`,
      );
    }
  }

  private validateChannel(channel: string): void {
    const supported = Object.values(MessageChannel);
    if (!supported.includes(channel as MessageChannel)) {
      throw new BadRequestException(
        `Canal no soportado: ${channel}. Opciones: ${supported.join(', ')}`,
      );
    }
  }

  private buildJobOptions(payload: MessagePayload, scheduledAt: Date) {
    const now = new Date();
    const delayMs = scheduledAt.getTime() - now.getTime();
    const isScheduled = delayMs > 1000;

    const priorityMap: Record<string, number> = {
      high: 1,
      normal: 5,
      low: 10,
    };

    const basePriority = priorityMap[payload.options?.priority ?? 'normal'];

    const priority = isScheduled ? basePriority + 10 : basePriority;

    return {
      priority,
      delay: delayMs > 0 ? delayMs : 0,
      jobId: `msg:${isScheduled ? 'i' : 's'}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
      isScheduled,
    };
  }
}
