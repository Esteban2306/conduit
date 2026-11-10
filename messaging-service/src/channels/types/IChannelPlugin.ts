export interface ChannelSendPayload {
  to: string;

  subject?: string;

  content: string;

  channels?: ChannelPreference[];

  connectionId?: string;

  priority?: 'conversation' | 'campaign';

  /** Id de mensaje fijo: un reintento reenvía el mismo id y WhatsApp no lo duplica. */
  messageId?: string;

  meta?: Record<string, unknown>;
}

export interface ChannelSendResult {
  success: boolean;

  provider: string;
  providerMessageId?: string;

  externalId?: string;

  error?: string;
  errorCode?: string;

  retryable?: boolean;

  raw: unknown;
}

export interface ChannelPreference {
  channel: 'EMAIL' | 'SMTP' | 'WHATSAPP';
  priority?: number;
}

export interface IChannelPlugin {
  readonly channel: string;
  readonly providerName: string;

  send(payload: ChannelSendPayload): Promise<ChannelSendResult>;
  validateRecipient(address: string): boolean;
  isAvailable?(connectionId?: string): boolean;
}
