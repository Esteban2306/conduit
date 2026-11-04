import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import {
  jobPayloadFromMessage,
  messageJobId,
  QUEUE_NAMES,
} from 'src/queue/queues';
import { Queue } from 'bullmq';
import { PrismaService } from 'src/shared/prisma.service';
import { MessageStatus } from '@prisma/client';
import { JobSigner, SignedJobPayload } from 'src/queue/security/JobSigner';
import { WebhookDispatcher } from 'src/webhooks/WebhookDispatcher';

@Injectable()
export class DLQHandler {
  private readonly logger = new Logger(DLQHandler.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.DEAD_LETTER)
    private readonly dlQueue: Queue,
    @InjectQueue(QUEUE_NAMES.MESSAGES)
    private readonly messageQueue: Queue<SignedJobPayload>,
    @InjectQueue(QUEUE_NAMES.MESSAGES_SCHEDULED)
    private readonly scheduledQueue: Queue<SignedJobPayload>,
    private readonly prisma: PrismaService,
    private readonly jobSigner: JobSigner,
    private readonly webhookDispatcher: WebhookDispatcher,
  ) {}

  /**
   * Punto único por el que un mensaje pasa a DEAD. Es idempotente: si el
   * mensaje ya está en la DLQ (y no fue re-encolado) no se duplica el
   * registro ni el webhook.
   */
  async handle(
    messageId: string,
    reason?: string,
    errorCode?: string,
  ): Promise<void> {
    const existing = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: {
        attempts: true,
        deadLetter: { select: { requeued: true } },
      },
    });

    if (!existing) {
      throw new Error(
        `No se puede mover a DLQ: Message ${messageId} no existe en DB`,
      );
    }
    if (existing.deadLetter && !existing.deadLetter.requeued) return;

    await this.prisma.$transaction([
      this.prisma.message.update({
        where: { id: messageId },
        data: {
          status: MessageStatus.DEAD,
          retryable: false,
          resolvedAt: new Date(),
          lastError: reason,
        },
      }),
      this.prisma.deadLetterMessage.upsert({
        where: { messageId },
        create: {
          messageId,
          reason: reason ?? 'Unknown',
          lastErrorCode: errorCode,
          lastErrorDetail: reason,
          totalAttempts: existing.attempts,
        },
        update: {
          reason: reason ?? 'Unknown',
          lastErrorCode: errorCode,
          lastErrorDetail: reason,
          totalAttempts: existing.attempts,
          requeued: false,
        },
      }),
    ]);

    await this.dlQueue.add(
      'dead-message',
      { messageId, errorCode },
      { jobId: `dlq-${messageId}-${Date.now()}` },
    );

    this.logger.warn(`Mensaje ${messageId} movido a DLQ. Razón: ${reason}`);
    await this.webhookDispatcher.dispatch('message.dead', messageId);
  }

  async requeue(messageId: string, reviewedBy?: string): Promise<void> {
    const deadLetter = await this.prisma.deadLetterMessage.findUnique({
      where: { messageId },
      include: { message: true },
    });

    if (!deadLetter) {
      throw new Error(`No existe mensaje muerto con id: ${messageId}`);
    }

    // El job fallido conserva el jobId determinista; mientras exista,
    // BullMQ ignoraría el nuevo `add`.
    for (const queue of [this.messageQueue, this.scheduledQueue]) {
      const job = await queue.getJob(messageJobId(messageId));
      if (job) await job.remove();
    }

    await this.prisma.$transaction([
      this.prisma.deadLetterMessage.update({
        where: { messageId },
        data: { requeued: true, reviewedBy, reviewedAt: new Date() },
      }),
      this.prisma.message.update({
        where: { id: messageId },
        data: {
          status: MessageStatus.QUEUED,
          retryable: true,
          attempts: 0,
          lastError: null,
          resolvedAt: null,
        },
      }),
    ]);

    const jobPayload = jobPayloadFromMessage(deadLetter.message);
    await this.messageQueue.add(
      `message:${deadLetter.message.channel}:requeue`,
      this.jobSigner.sign({ ...jobPayload, sheduledAt: undefined }),
      { jobId: messageJobId(messageId) },
    );

    this.logger.log(
      `Mensaje ${messageId} re-encolado manualmente por: ${reviewedBy ?? 'sistema'}`,
    );
  }
}
