import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/shared/prisma.service';
import * as crypto from 'crypto';
import axios from 'axios';

export type WebhookEvent =
  | 'message.sent'
  | 'message.failed'
  | 'message.dead'
  | 'message.cancelled';

export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: string;
  data: {
    messageId: string;
    channel: string;
    recipient: string;
    status: string;
    provider?: string;
    error?: string;
    meta?: unknown;
  };
}

@Injectable()
export class WebhookDispatcher {
  private readonly logger = new Logger(WebhookDispatcher.name);

  constructor(private readonly prisma: PrismaService) {}

  async dispatch(event: WebhookEvent, messageId: string): Promise<void> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
    });

    if (!message) return;

    const webhooks = await this.prisma.webhookEndpoint.findMany({
      where: {
        tenantId: message.tenantId,
        isActive: true,
      },
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
        status: message.status,
        provider: message.provider ?? undefined,
        error: message.lastError ?? undefined,
        meta: message.meta,
      },
    };

    await Promise.allSettled(
      relevant.map((webhook) =>
        this.send(webhook.id, webhook.url, webhook.secret, payload),
      ),
    );
  }

  private async send(
    webhookId: string,
    url: string,
    secret: string,
    payload: WebhookPayload,
  ): Promise<void> {
    const body = JSON.stringify(payload);

    const signature = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');

    const start = Date.now();
    let httpStatus: number | null = null;
    let responseBody: string | null = null;

    try {
      const response = await axios.post(url, payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Conduit-Signature': `sha256=${signature}`,
          'X-Conduit-Event': payload.event,
        },
        timeout: 5000,
      });

      httpStatus = response.status;
      responseBody = JSON.stringify(response.data).slice(0, 500);

      this.logger.log(`Webhook entregado a ${url} | Status: ${httpStatus}`);
    } catch (err) {
      httpStatus = err?.response?.status ?? null;
      responseBody = err?.message ?? 'Unknown error';

      this.logger.warn(`Webhook fallido a ${url} | Error: ${responseBody}`);
    } finally {
      await this.prisma.webhookDelivery.create({
        data: {
          webhookId,
          messageId: payload.data.messageId,
          eventType: payload.event,
          httpStatus,
          responseBody,
          attempts: 1,
          deliveredAt: httpStatus && httpStatus < 400 ? new Date() : null,
        },
      });
    }
  }
}
