import { ConversationStatus, SourceVariable } from '@prisma/client';

export const EVENT_TYPES = {
  MESSAGE_RECEIVED: 'message.received',
  MESSAGE_GENERATED: 'message.generated',

  // ai

  BOT_RESPONSE_REQUESTED: 'bot.response.requested',

  BOT_RESPONSE_GENERATED: 'bot.response.generated',

  BOT_RESPONSE_FAILED: 'bot.response.failed',

  // conversation

  CONVERSATION_CREATED: 'conversation.created',

  CONVERSATION_UPDATED: 'conversation.updated',

  CONVERSATION_LOCK_ACQUIRED: 'conversation.lock.acquired',

  CONVERSATION_LOCK_FAILED: 'conversation.lock.failed',

  CONVERSATION_CLOSED: 'conversation.closed',

  CONTEXT_UPDATED: 'context.updated',

  CHANNEL_SEND_REQUESTED: 'channel.send.requested',

  CHANNEL_SEND_COMPLETED: 'channel.send.completed',

  CHANNEL_SEND_FAILED: 'channel.send.failed',

  // orchestration

  MESSAGE_DISPATCH_REQUESTED: 'message.dispatch.requested',

  // channels

  WHATSAPP_CONNECTED: 'whatsapp.connected',

  WHATSAPP_DISCONNECTED: 'whatsapp.disconnected',

  //External

  EXTERNAL_DATA_RECEIVED: 'external_data.received',

  EXTERNAL_DATA_PROCESSED: 'external_data.processed',

  EXTERNAL_DATA_FAILED: 'external_data.failed',

  VARIABLES_UPDATED: 'variables.updated',

  VARIABLES_DELETED: 'variables.deleted',

  MAPPING_UPDATED: 'mapping.updated',

  //Webhook

  WEBHOOK_ACTION_TRIGGERED: 'webhook.action.triggered',
} as const;

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES];

export interface EventPayloadMap {
  [EVENT_TYPES.MESSAGE_RECEIVED]: {
    messageId: string;
    conversationId: string;
    content: string;
    hasImage: boolean;
  };

  [EVENT_TYPES.CONVERSATION_CREATED]: {
    conversationId: string;

    botConfigId: string;

    tenantId: string;

    phoneNumber: string;
  };

  [EVENT_TYPES.CHANNEL_SEND_REQUESTED]: {
    phoneNumber: string;
    content: string;
    conversationId: string | null;
    connectionId: string | null;
    tokensUsed?: number;
    imageVerified?: boolean;
  };

  [EVENT_TYPES.CHANNEL_SEND_COMPLETED]: {
    phoneNumber: string;
    providerMessageId?: string;
  };

  [EVENT_TYPES.CHANNEL_SEND_FAILED]: {
    phoneNumber: string;
    error: string;
    retryable: boolean;
  };

  [EVENT_TYPES.CONVERSATION_LOCK_ACQUIRED]: {
    conversationId: string;
  };

  [EVENT_TYPES.CONVERSATION_LOCK_FAILED]: {
    conversationId: string;
  };

  [EVENT_TYPES.CONTEXT_UPDATED]: {
    conversationId: string;
    step?: string;
    intent?: string;
  };

  [EVENT_TYPES.CONVERSATION_UPDATED]: {
    conversationId: string;

    updates: Record<string, unknown>;
  };

  [EVENT_TYPES.CONVERSATION_CLOSED]: {
    conversationId: string;
    status: ConversationStatus;
    reason?: string;
  };

  [EVENT_TYPES.BOT_RESPONSE_REQUESTED]: {
    conversationId: string;

    botConfigId: string;

    userMessage: string;

    hasImage: boolean;
  };

  [EVENT_TYPES.BOT_RESPONSE_GENERATED]: {
    conversationId: string;

    response: string;

    intent?: string;

    model?: string;

    tokensUsed?: number;
  };

  [EVENT_TYPES.BOT_RESPONSE_FAILED]: {
    conversationId: string;

    error: string;
  };

  [EVENT_TYPES.MESSAGE_DISPATCH_REQUESTED]: {
    conversationId: string;

    phoneNumber: string;

    content: string;
  };

  [EVENT_TYPES.MESSAGE_GENERATED]: {
    conversationId: string;

    messageId: string;

    content: string;

    intent: string | undefined;
  };

  [EVENT_TYPES.WHATSAPP_CONNECTED]: {
    sessionId: string;

    connectedAt: Date;
  };

  [EVENT_TYPES.WHATSAPP_DISCONNECTED]: {
    sessionId: string;

    disconnectedAt: Date;

    reason?: string;
  };

  [EVENT_TYPES.EXTERNAL_DATA_RECEIVED]: {
    eventId: string;
    botConfigId: string;
    eventType: string;
  };

  [EVENT_TYPES.EXTERNAL_DATA_PROCESSED]: {
    eventId: string;
    botConfigId: string;
    eventType: string;
    mapped: number;
  };

  [EVENT_TYPES.EXTERNAL_DATA_FAILED]: {
    eventId: string;
    botConfigId: string;
    eventType: string;
    error: string;
  };

  [EVENT_TYPES.VARIABLES_UPDATED]: {
    botConfigId: string;
    source: SourceVariable;
    count: number;
    namespaces?: string[];
  };

  [EVENT_TYPES.VARIABLES_DELETED]: {
    botConfigId: string;
    deleted: number;
  };

  [EVENT_TYPES.MAPPING_UPDATED]: {
    botConfigId: string;
    eventType: string;
  };

  [EVENT_TYPES.WEBHOOK_ACTION_TRIGGERED]: {
    tenantId: string;
    connectionId: string;
    recipient: string;
    templateId?: string;
    inlineBody?: string;
    variables: Record<string, unknown>;
    scheduledAt?: string; // ISO 8601, ausente = inmediato
    priority?: 'low' | 'normal' | 'high';
  };
}

/* **"EventBusService en memoria, sin outbox transaccional, sin DLQ de eventos".** Es cierto y es una limitación real. Pero antes 
de construir un patrón outbox completo (que es trabajo no trivial), la pregunta es: ¿con cuántas réplicas del servidor vas a correr 
para un negocio? Si es una sola instancia (razonable para un primer cliente), el riesgo real es "el proceso se cae entre que actualizo 
la DB y disparo el evento" — una ventana de milisegundos, no un problema estructural constante. Es una mejora de robustez legítima 
para cuando tengas múltiples clientes con alta concurrencia, no un bloqueante para lanzar con el spa. No dejes que la auditoría te 
empuje a sobre-ingeniería antes de necesitarla.  */
