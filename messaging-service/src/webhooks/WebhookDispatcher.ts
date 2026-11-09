import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MessageStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/shared/prisma.service';
import { QUEUE_NAMES } from 'src/queue/queues';

/**
 * Solo se notifican estados terminales: el integrador recibe un único
 * evento final por mensaje. `message.failed` se conserva en el tipo por
 * compatibilidad con suscripciones existentes, pero ya no se emite (los
 * fallos transitorios se reintentan y terminan en `sent` o `dead`).
 */
export type WebhookEvent =
  | 'message.sent'
  | 'message.failed'
  | 'message.dead'
  | 'message.cancelled';

const EVENT_STATUS: Record<WebhookEvent, MessageStatus> = {
  'message.sent': MessageStatus.SENT,
  'message.failed': MessageStatus.FAILED,
  'message.dead': MessageStatus.DEAD,
  'message.cancelled': MessageStatus.CANCELLED,
};

/** Eventos del sistema (no ligados a un mensaje): alertas operativas. */
export type SystemWebhookEvent = 'ops.alert' | VerificationWebhookEvent;

/**
 * Resultado de un especialista (solo vínculos ACTIVE): un evento por
 * veredicto, para que cada tenant elija a cuáles suscribirse, más el cierre
 * de una revisión humana.
 */
export const VERIFICATION_VERDICT_EVENTS = {
  VALID: 'verification.valid',
  INVALID: 'verification.invalid',
  NEEDS_REVIEW: 'verification.needs_review',
  UNREADABLE: 'verification.unreadable',
  NOT_APPLICABLE: 'verification.not_applicable',
  ERROR: 'verification.error',
} as const;
export const VERIFICATION_REVIEWED_EVENT = 'verification.reviewed' as const;

export type VerificationWebhookEvent =
  | (typeof VERIFICATION_VERDICT_EVENTS)[keyof typeof VERIFICATION_VERDICT_EVENTS]
  | typeof VERIFICATION_REVIEWED_EVENT;

export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: string;
  data: {
    messageId: string;
    channel: string;
    recipient: string;
    status: MessageStatus;
    provider?: string;
    providerMessageId?: string;
    error?: string;
    meta?: unknown;
  };
}

export interface WebhookDeliveryJob {
  deliveryId: string;
}

@Injectable()
export class WebhookDispatcher {
  private readonly logger = new Logger(WebhookDispatcher.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.WEBHOOKS)
    private readonly webhookQueue: Queue<WebhookDeliveryJob>,
  ) {}

  /**
   * Registra una entrega por cada endpoint suscrito y la encola. El cuerpo
   * se congela aquí: todos los reintentos firman y envían exactamente lo
   * mismo, y el id de la entrega viaja como `X-Conduit-Event-Id` para que
   * el receptor deduplique.
   *
   * Nunca lanza: un problema notificando no debe deshacer el envío.
   */
  async dispatch(event: WebhookEvent, messageId: string): Promise<void> {
    try {
      const message = await this.prisma.message.findUnique({
        where: { id: messageId },
      });
      if (!message) return;

      const webhooks = await this.prisma.webhookEndpoint.findMany({
        where: { tenantId: message.tenantId, isActive: true },
        select: { id: true, events: true },
      });

      const relevant = webhooks.filter((w) => {
        const events = Array.isArray(w.events) ? (w.events as string[]) : [];
        return events.includes(event) || events.includes('*');
      });
      if (relevant.length === 0) return;

      const payload: WebhookPayload = {
        event,
        timestamp: new Date().toISOString(),
        data: {
          messageId: message.id,
          channel: message.channel,
          recipient: message.recipient,
          status: EVENT_STATUS[event],
          provider: message.provider ?? undefined,
          providerMessageId: message.providerMessageId ?? undefined,
          error: message.lastError ?? undefined,
          meta: message.meta ?? undefined,
        },
      };

      for (const webhook of relevant) {
        const delivery = await this.prisma.webhookDelivery.create({
          data: {
            webhookId: webhook.id,
            messageId: message.id,
            eventType: event,
            payload: payload as unknown as Prisma.InputJsonValue,
            attempts: 0,
          },
        });

        await this.webhookQueue.add(
          'deliver',
          { deliveryId: delivery.id },
          { jobId: `wh-${delivery.id}` },
        );
      }
    } catch (error) {
      this.logger.error(
        `No fue posible registrar el webhook ${event} del mensaje ${messageId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Alertas operativas del tenant (sesión de WhatsApp caída, respuestas sin
   * entregar). Mismas garantías que `dispatch`: cuerpo congelado, firmado y
   * reintentado; nunca lanza.
   */
  async dispatchSystem(
    tenantId: string,
    event: SystemWebhookEvent,
    data: Record<string, unknown>,
  ): Promise<number> {
    try {
      const webhooks = await this.prisma.webhookEndpoint.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, events: true },
      });
      const relevant = webhooks.filter((w) => {
        const events = Array.isArray(w.events) ? (w.events as string[]) : [];
        return events.includes(event) || events.includes('*');
      });
      const payload = {
        event,
        timestamp: new Date().toISOString(),
        data,
      };

      for (const webhook of relevant) {
        const delivery = await this.prisma.webhookDelivery.create({
          data: {
            webhookId: webhook.id,
            eventType: event,
            payload: payload as unknown as Prisma.InputJsonValue,
            attempts: 0,
          },
        });
        await this.webhookQueue.add(
          'deliver',
          { deliveryId: delivery.id },
          { jobId: `wh-${delivery.id}` },
        );
      }
      return relevant.length;
    } catch (error) {
      this.logger.error(
        `No fue posible registrar el webhook ${event} del tenant ${tenantId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    }
  }
}
