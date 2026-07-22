import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { QUEUE_NAMES } from 'src/queue/queues';
import { Queue } from 'bullmq';
import { PrismaService } from 'src/shared/prisma.service';
import { MessageStatus } from '@prisma/client';

@Injectable()
export class DLQHandler {
  private readonly logger = new Logger(DLQHandler.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.DEAD_LETTER)
    private readonly dlQueue: Queue,
    private readonly prisma: PrismaService,
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

    this.logger.log(
      `Mensaje ${messageId} re-encolado manualmente por: ${reviewedBy ?? 'sistema'}`,
    );
  }
}
