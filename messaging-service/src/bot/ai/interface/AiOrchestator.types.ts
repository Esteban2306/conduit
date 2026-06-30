import { ConversationContext } from 'src/bot/conversation/interfaces/ConversationContext';
import { HistoryMessage } from 'src/bot/conversation/interfaces/ConversationHistory';

export interface GenerateResponseInput {
  botConfigId: string;
  systemPrompt: string;
  userMessage: string;
  history: HistoryMessage[];
  context: ConversationContext;
  summary?: string | null;
  maxTokens?: number;
  temperature?: number;
}

export interface AnalyzeImageInput {
  botConfigId: string;
  systemPrompt: string;
  prompt: string;
  imageBuffer: Buffer;
  mimeType: string;
}

export interface OrchestratorResult {
  content: string;
  tokensUsed: number;
  modelUsed: string;
  providerUsed: string;
  latencyMs: number;
  modelConfigId: string;
}
