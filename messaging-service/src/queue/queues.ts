import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';

export const QUEUE_NAMES = {
  MESSAGES: 'conduit-messages',
  MESSAGES_SCHEDULED: 'conduit-messages-scheduled',
  DEAD_LETTER: 'conduit-dead-letter',
} as const;

export interface MessageJobPayload {
  messageId: string;
  tenantId: string;
  channel: string;
  recipient: string;
  templateId: string;
  inlineBody: string;
  inlineSubject: string;
  variables: Record<string, unknown>;
  meta?: Record<string, unknown>;
  sheduledAt?: string;
  isScheduled?: boolean;
}

export function createMessageQueue(
  config: ConfigService,
): Queue<MessageJobPayload> {
  return new Queue(QUEUE_NAMES.MESSAGES, {
    connection: {
      host: config.get<string>('redis.host'),
      port: config.get<number>('redis.port'),
    },
    defaultJobOptions: {
      attempts: config.get<number>('queue.maxAttempts') ?? 3,
      backoff: {
        type: 'exponential',
        delay: config.get<number>('queue.backoffDelay') ?? 120000,
      },
      removeOnComplete: { count: 1000 },
      removeOnFail: false,
    },
  });
}

export function createScheduledQueue(
  config: ConfigService,
): Queue<MessageJobPayload> {
  return new Queue(QUEUE_NAMES.MESSAGES_SCHEDULED, {
    connection: {
      host: config.get<string>('redis.host'),
      port: config.get<number>('redis.port'),
    },
    defaultJobOptions: {
      attempts: config.get<number>('queue.maxAttempts') ?? 3,
      backoff: {
        type: 'exponential',
        delay: config.get<number>('queue.backoffDelay') ?? 120000,
      },
      removeOnComplete: { count: 3 },
      removeOnFail: false,
    },
  });
}

export function createDeadLetterQueue(config: ConfigService): Queue {
  return new Queue(QUEUE_NAMES.DEAD_LETTER, {
    connection: {
      host: config.get<string>('redis.host'),
      port: config.get<number>('redis.port'),
    },
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    },
  });
}
