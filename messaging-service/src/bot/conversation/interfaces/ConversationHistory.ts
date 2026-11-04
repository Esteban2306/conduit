import { MessageRole } from '../types/MessageRole';

export interface HistoryMessage {
  role: MessageRole;
  content: string;
}

export interface ConversationHistory {
  conversationId: string;
  phoneNumber: string;
  messages: HistoryMessage[];
  context: Record<string, unknown>;
  totalMessages: number;
}
