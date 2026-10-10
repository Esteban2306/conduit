import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Message, MessageStatus } from '@prisma/client';
import { PrismaService } from 'src/shared/prisma.service';
import {
  jobPayloadFromMessage,
  messageJobId,
  QUEUE_NAMES,
} from 'src/queue/queues';
import { JobSigner, SignedJobPayload } from 'src/queue/security/JobSigner';
import { DLQHandler } from 'src/queue/Orchestrator/deadletter/DLQHandler';
import { WebhookDispatcher } from 'src/webhooks/WebhookDispatcher';

const NON_TERMINAL: MessageStatus[] = [
  MessageStatus.PENDING,
  MessageStatus.QUEUED,
  MessageStatus.RETRYING,
  MessageStatus.PROCESSING,
];

/** Estados en los que el job sigue vivo y el worker se encargará. */
const LIVE_JOB_STATES = new Set([
  'waiting',
  'delayed',
  'active',
  'prioritized',
  'waiting-children',
]);

/**
 * Red de seguridad para mensajes que quedaron sin estado final: Redis caído
 * al encolar, reinicio a mitad de proceso o jobs agotados sin registro.
 *
 * Regla anti-duplicados: solo se re-encola cuando hay certeza de que el
 * mensaje no salió. Si el resultado es incierto, va a la DLQ para revisión
 * en vez de arriesgar un segundo envío al mismo cliente.
 */
@Injectable()
export class MessageRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessageRecoveryService.name);

  private readonly SWEEP_INTERVAL_MS = 5 * 60 * 1000;
  private readonly STALE_AFTER_MS = 15 * 60 * 1000;
  private readonly BATCH_SIZE = 100;

  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.MESSAGES)
    private readonly messageQueue: Queue<SignedJobPayload>,
    @InjectQueue(QUEUE_NAMES.MESSAGES_SCHEDULED)
    private readonly scheduledQueue: Queue<SignedJobPayload>,
    private readonly jobSigner: JobSigner,
    private readonly dlqHandler: DLQHandler,
    private readonly webhookDispatcher: WebhookDispatcher,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    try {
      const cutoff = new Date(Date.now() - this.STALE_AFTER_MS);
      const stale = await this.prisma.message.findMany({
        where: {
          status: { in: NON_TERMINAL },
          updatedAt: { lt: cutoff },
          scheduledAt: { lt: cutoff },
        },
        orderBy: { updatedAt: 'asc' },
        take: this.BATCH_SIZE,
      });

      let recovered = 0;
      for (const message of stale) {
        try {
          if (await this.recover(message)) recovered++;
        } catch (error) {
          this.logger.error(
            `No fue posible recuperar el mensaje ${message.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (recovered > 0) {
        this.logger.warn(
          `Barrido de recuperación: ${recovered} mensaje(s) atascado(s) resuelto(s)`,
        );
      }
      return recovered;
    } finally {
      this.running = false;
    }
  }

  private async recover(message: Message): Promise<boolean> {
    const job = await this.findJob(message.id);

    if (!job) return this.recoverWithoutJob(message);

    const state = await job.getState();
    if (LIVE_JOB_STATES.has(state)) return false;

    if (state === 'failed') {
      await this.dlqHandler.handle(
        message.id,
        job.failedReason ?? message.lastError ?? 'Reintentos agotados',
        'MAX_ATTEMPTS_EXCEEDED',
      );
      return true;
    }

    if (state === 'completed') {
      if (message.sentAt) {
        await this.prisma.message.update({
          where: { id: message.id },
          data: { status: MessageStatus.SENT },
        });
        await this.webhookDispatcher.dispatch('message.sent', message.id);
      } else {
        await this.dlqHandler.handle(
          message.id,
          'El job terminó sin registrar el resultado del envío',
          'UNKNOWN_OUTCOME',
        );
      }
      return true;
    }

    return false;
  }

  private async recoverWithoutJob(message: Message): Promise<boolean> {
    if (message.status === MessageStatus.PROCESSING) {
      // Pudo haber salido antes de perderse el job: no se reenvía a ciegas.
      await this.dlqHandler.handle(
        message.id,
        'Mensaje en PROCESSING sin job asociado; resultado del envío desconocido',
        'UNKNOWN_OUTCOME',
      );
      return true;
    }

    await this.messageQueue.add(
      `message:${message.channel}:recovered`,
      this.jobSigner.sign({
        ...jobPayloadFromMessage(message),
        sheduledAt: undefined,
      }),
      { jobId: messageJobId(message.id) },
    );
    await this.prisma.message.update({
      where: { id: message.id },
      data: { status: MessageStatus.QUEUED },
    });

    this.logger.warn(
      `Mensaje ${message.id} (${message.status}) sin job en cola: re-encolado`,
    );
    return true;
  }

  private async findJob(
    messageId: string,
  ): Promise<Job<SignedJobPayload> | undefined> {
    const jobId = messageJobId(messageId);
    return (
      (await this.messageQueue.getJob(jobId)) ??
      (await this.scheduledQueue.getJob(jobId))
    );
  }
}
