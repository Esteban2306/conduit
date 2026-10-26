import { ConversationContext } from 'src/bot/conversation/interfaces/ConversationContext';
import { HistoryMessage } from 'src/bot/conversation/interfaces/ConversationHistory';
import {
  ReasoningLevel,
  SystemBlocks,
  TokenUsage,
  ToolExecutor,
  ToolSpec,
} from './AiProvider';
import type { TurnBudget } from '../turn-budget';

export interface GenerateResponseInput {
  botConfigId: string;
  systemPrompt: string;
  systemBlocks?: SystemBlocks;
  reasoningMode?: ReasoningLevel;
  userMessage: string;
  history: HistoryMessage[];
  context: ConversationContext;
  summary?: string | null;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolSpec[];
  toolExecutor?: ToolExecutor;
  budget?: TurnBudget;
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
  usage?: TokenUsage;
  stopReason?: string | null;
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
