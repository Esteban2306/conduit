export interface HistoryEntry {
  role: string;
  content: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parametersSchema: Record<string, any>;
}

export interface ToolExecutionRequest {
  name: string;
  arguments: Record<string, unknown>;
  attachedImage?: {
    dataUri: string;
    mimeType: string;
    sizeBytes: number;
  };
}

export interface ToolExecutionResult {
  ok: boolean;
  content: Record<string, unknown>;
}

export type ToolExecutor = (
  req: ToolExecutionRequest,
) => Promise<ToolExecutionResult>;

export interface GenerateTextInput {
  prompt: string;
  systemPrompt: string;
  history?: HistoryEntry[];
  model: string;
  apiKey: string;
  baseUrl: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolSpec[];
  toolExecutor?: ToolExecutor;
  maxToolIterations?: number;
}

export interface AnalyzeImageInput {
  prompt: string;
  botConfigId: string;
  systemPrompt: string;
  imageBuffer: Buffer;
  mimeType: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
}

export interface GenerateTextResult {
  content: string;
  tokensUsed: number;
  model: string;
  provider: string;
  latencyMs: number;
  toolCallsExecuted?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    ok: boolean;
  }>;
}

export interface AiProvider {
  readonly providerName: string;
  readonly supportsTools?: boolean;
  generateText(input: GenerateTextInput): Promise<GenerateTextResult>;
  analyzeImage(input: AnalyzeImageInput): Promise<GenerateTextResult>;
}
