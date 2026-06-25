import { AiProviderType } from '../ai/interface/AiProviderType';

export const DEFAULT_MODELS: Record<AiProviderType, string> = {
  GEMINI: 'gemini-3.5-flash',
  OPENAI: 'gpt-4o-mini',
  ANTHROPIC: 'claude-haiku-4-6',
  GROQ: 'llama-3.3-70b-versatile',
  DEEPSEEK: 'deepseek-v4-flash',
  MISTRAL: 'mistral-small-latest',
  OPENROUTER: 'nemotron-nano-12b-v2-vl:free',
  CUSTOM: '',
};
