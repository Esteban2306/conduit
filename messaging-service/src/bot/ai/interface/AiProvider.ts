export interface GenerateTextInput {
  prompt: string;
  systemPrompt: string;
  history?: {
    role: string;
    content: string;
  }[];
  model: string;
  apiKey: string;
  baseUrl: string;
  maxTokens?: number;
  temperature?: number;
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
}

export interface AiProvider {
  readonly providerName: string;
  generateText(input: GenerateTextInput): Promise<GenerateTextResult>;
  analyzeImage(input: AnalyzeImageInput): Promise<GenerateTextResult>;
}
