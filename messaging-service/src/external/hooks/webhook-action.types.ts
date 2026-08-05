export interface WebhookAction {
  enabled: boolean;
  connectionId: string;
  recipientField: string;
  templateId?: string;
  inlineBody?: string;
  scheduleField?: string;
  scheduleOffsetMinutes?: number;
  priority?: 'low' | 'normal' | 'high';
}
