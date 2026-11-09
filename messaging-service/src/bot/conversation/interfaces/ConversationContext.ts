export interface ConversationContext {
  step?: string;
  service?: string;
  serviceId?: string;
  amount?: number;
  slotId?: string;
  clientName?: string;
  appointmentDate?: string;
  paymentVerified?: boolean;
  pendingIntent?: string;
  lastIntent?: string;
  retryCount?: number;
  facts?: unknown;
  [key: string]: unknown;
}
