import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, UnrecoverableError, Worker } from 'bullmq';
import axios from 'axios';
import * as crypto from 'crypto';
import { PrismaService } from 'src/shared/prisma.service';
import { QUEUE_NAMES } from 'src/queue/queues';
import type { WebhookDeliveryJob } from './WebhookDispatcher';
import { closeWorkerGracefully } from 'src/queue/BullMQ/close-worker';

/** 4xx que sí vale la pena reintentar: el receptor pide esperar. */
const RETRYABLE_CLIENT_STATUSES = new Set([408, 425, 429]);

@Injectable()
export class WebhookDeliveryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookDeliveryWorker.name);
  private worker: Worker<WebhookDeliveryJob>;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.worker = new Worker<WebhookDeliveryJob>(
      QUEUE_NAMES.WEBHOOKS,
      (job) => this.deliver(job),
      {
        connection: {
          host: this.config.get<string>('redis.host'),
          port: this.config.get<number>('redis.port'),
        },
        concurrency: 5,
      },
    );

    this.worker.on('failed', (job, error) => {
      if (!job) return;
      const exhausted =
        error instanceof UnrecoverableError ||
        job.attemptsMade >= (job.opts.attempts ?? 1);
      if (!exhausted) return;

      this.logger.error(
        `Webhook ${job.data.deliveryId} abandonado tras ${job.attemptsMade} intento(s): ${error.message}`,
      );
      this.prisma.webhookDelivery
        .update({
          where: { id: job.data.deliveryId },
          data: { failedAt: new Date() },
        })
        .catch(() => {});
    });
  }

  async onModuleDestroy() {
    await closeWorkerGracefully(this.worker);
  }

  private async deliver(job: Job<WebhookDeliveryJob>): Promise<void> {
    const delivery = await this.prisma.webhookDelivery.findUnique({
      where: { id: job.data.deliveryId },
      include: { webhook: true },
    });

    if (!delivery || delivery.deliveredAt) return;
    if (!delivery.webhook.isActive || !delivery.payload) {
      throw new UnrecoverableError('Webhook inactivo o entrega sin payload');
    }

    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = crypto
      .createHmac('sha256', delivery.webhook.secret)
      .update(body)
      .digest('hex');
    // V2 firma también el timestamp: el receptor puede rechazar reenvíos
    // de un webhook capturado (ventana de pocos minutos). La V1 se mantiene
    // por compatibilidad con receptores existentes.
    const signatureV2 = crypto
      .createHmac('sha256', delivery.webhook.secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    let httpStatus: number | null = null;
    let responseBody: string | null = null;

    try {
      const response = await axios.post(delivery.webhook.url, body, {
        headers: {
          'Content-Type': 'application/json',
          'X-Conduit-Signature': `sha256=${signature}`,
          'X-Conduit-Signature-V2': `sha256=${signatureV2}`,
          'X-Conduit-Event': delivery.eventType,
          'X-Conduit-Event-Id': delivery.id,
          'X-Conduit-Timestamp': timestamp,
        },
        timeout: 10_000,
        // Se envía el string exacto que se firmó, sin re-serializar.
        transformRequest: [(data: string) => data],
        validateStatus: () => true,
      });
      httpStatus = response.status;
      responseBody = this.truncate(response.data);
    } catch (error) {
      responseBody = error instanceof Error ? error.message : String(error);
    }

    const delivered = httpStatus !== null && httpStatus < 300;

    await this.prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attempts: { increment: 1 },
        httpStatus,
        responseBody,
        deliveredAt: delivered ? new Date() : null,
      },
    });

    if (delivered) {
      this.logger.log(
        `Webhook ${delivery.eventType} entregado a ${delivery.webhook.url} | ${httpStatus}`,
      );
      return;
    }

    const reason = `HTTP ${httpStatus ?? 'sin respuesta'}: ${responseBody ?? ''}`;
    if (
      httpStatus !== null &&
      httpStatus >= 400 &&
      httpStatus < 500 &&
      !RETRYABLE_CLIENT_STATUSES.has(httpStatus)
    ) {
      throw new UnrecoverableError(
        `Rechazo permanente del receptor. ${reason}`,
      );
    }
    throw new Error(reason);
  }

  private truncate(data: unknown): string {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return (text ?? '').slice(0, 500);
  }
}
