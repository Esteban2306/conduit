import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { MessageJobPayload, QUEUE_NAMES } from 'src/queue/queues';
import { Queue } from 'bullmq';
import { PrismaService } from 'src/shared/prisma.service';
import { MessageStatus } from '@prisma/client';
import { JobSigner } from 'src/queue/security/JobSigner';

@Injectable()
export class DLQHandler {
  private readonly logger = new Logger(DLQHandler.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.DEAD_LETTER)
    private readonly dlQueue: Queue,
    @InjectQueue(QUEUE_NAMES.MESSAGES)
    private readonly messageQueue: Queue<MessageJobPayload>,
    private readonly prisma: PrismaService,
    private readonly jobSigner: JobSigner,
  ) {}

  async handle(
    messageId: string,
    reason?: string,
    errorCode?: string,
  ): Promise<void> {
    const existing = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { attempts: true },
    });

    if (!existing) {
      throw new Error(
        `No se puede mover a DLQ: Message ${messageId} no existe en DB`,
      );
    }

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
      this.prisma.deadLetterMessage.create({
        data: {
          messageId,
          reason: reason ?? 'Unknown',
          lastErrorCode: errorCode,
          lastErrorDetail: reason,
          totalAttempts: existing.attempts,
        },
      }),
    ]);

    await this.dlQueue.add(
      'dead-message',
      { messageId, errorCode },
      { jobId: `dlq-${messageId}` },
    );

    this.logger.warn(`Mensaje ${messageId} movido a DLQ. Razón: ${reason}`);
  }

  async requeue(messageId: string, reviewedBy?: string): Promise<void> {
    const deadLetter = await this.prisma.deadLetterMessage.findUnique({
      where: { messageId },
      include: { message: true },
    });

    if (!deadLetter) {
      throw new Error(`No existe mensaje muerto con id: ${messageId}`);
    }

    const message = deadLetter.message;

    await this.prisma.deadLetterMessage.update({
      where: { messageId },
      data: {
        requeued: true,
        reviewedBy,
        reviewedAt: new Date(),
      },
    });

    await this.prisma.message.update({
      where: { id: messageId },
      data: {
        status: MessageStatus.PENDING,
        retryable: true,
        attempts: 0,
        lastError: null,
        resolvedAt: null,
      },
    });

    const jobPayload: MessageJobPayload = {
      messageId: message.id,
      tenantId: message.tenantId,
      channel: message.channel,
      recipient: message.recipient,
      connectionId: message.connectionId ?? undefined,
      templateId: message.templateId ?? '',
      inlineBody: message.renderedBody ?? '',
      inlineSubject: message.renderedSubject ?? '',
      variables: (message.variables as Record<string, unknown>) ?? {},
      meta: (message.meta as Record<string, unknown>) ?? undefined,
      sheduledAt: undefined,
    };

    const signedPayload = this.jobSigner.sign(jobPayload);

    await this.messageQueue.add(
      `message:${message.channel}:requeue`,
      signedPayload,
      { jobId: `requeue-${messageId}-${Date.now()}` },
    );

    this.logger.log(
      `Mensaje ${messageId} re-encolado manualmente por: ${reviewedBy ?? 'sistema'}`,
    );
  }
}
