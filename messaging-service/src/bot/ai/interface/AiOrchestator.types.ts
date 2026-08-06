import { ConversationContext } from 'src/bot/conversation/interfaces/ConversationContext';
import { HistoryMessage } from 'src/bot/conversation/interfaces/ConversationHistory';
import { ToolExecutor, ToolSpec } from './AiProvider';

export interface GenerateResponseInput {
  botConfigId: string;
  systemPrompt: string;
  userMessage: string;
  history: HistoryMessage[];
  context: ConversationContext;
  summary?: string | null;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolSpec[];
  toolExecutor?: ToolExecutor;
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
  toolCallsExecuted?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    ok: boolean;
  }>;
}
