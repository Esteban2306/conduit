import { ConfigService } from '@nestjs/config';
import type { DefaultJobOptions } from 'bullmq';
import type { Message } from '@prisma/client';

export const QUEUE_NAMES = {
  MESSAGES: 'conduit-messages',
  MESSAGES_SCHEDULED: 'conduit-messages-scheduled',
  DEAD_LETTER: 'conduit-dead-letter',
  WEBHOOKS: 'conduit-webhooks',
} as const;

export interface MessageJobPayload {
  messageId: string;
  tenantId: string;
  channel: string;
  recipient: string;
  connectionId: string | undefined;
  templateId: string;
  inlineBody: string;
  inlineSubject: string;
  variables: Record<string, unknown>;
  meta?: Record<string, unknown>;
  sheduledAt?: string;
  isScheduled?: boolean;
}

/**
 * jobId determinista por mensaje: BullMQ ignora un `add` con un jobId que
 * ya existe, así que encolar dos veces el mismo mensaje (reintento HTTP,
 * barrido de recuperación) nunca produce dos envíos.
 */
export function messageJobId(messageId: string): string {
  return `msg-${messageId}`;
}

/**
 * Reintentos y retención comunes a las colas de mensajes. Sin `attempts`
 * BullMQ ejecuta el job una sola vez y un fallo transitorio (WhatsApp
 * reconectando) dejaría el mensaje atascado.
 */
export function messageJobDefaults(
  config: ConfigService,
  overrides: Partial<DefaultJobOptions> = {},
): DefaultJobOptions {
  return {
    attempts: config.get<number>('queue.maxAttempts') ?? 5,
    backoff: {
      type: 'exponential',
      delay: config.get<number>('queue.backoffDelay') ?? 120000,
    },
    removeOnComplete: { count: 1000 },
    removeOnFail: { age: 30 * 24 * 60 * 60 },
    ...overrides,
  };
}

/** Reconstruye el payload de un job a partir del registro persistido. */
export function jobPayloadFromMessage(message: Message): MessageJobPayload {
  const isFuture = message.scheduledAt.getTime() > Date.now();
  return {
    messageId: message.id,
    tenantId: message.tenantId,
    channel: message.channel,
    recipient: message.recipient,
    connectionId: message.connectionId ?? undefined,
    templateId: message.templateId ?? '',
    inlineBody: message.templateId ? '' : (message.renderedBody ?? ''),
    inlineSubject: message.templateId ? '' : (message.renderedSubject ?? ''),
    variables: (message.variables as Record<string, unknown>) ?? {},
    meta: (message.meta as Record<string, unknown>) ?? undefined,
    sheduledAt: isFuture ? message.scheduledAt.toISOString() : undefined,
  };
}
