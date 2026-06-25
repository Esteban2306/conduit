import { Injectable } from '@nestjs/common';

import { OpenAIProvider } from './providers/OpenAIProvider';
import { GeminiProvider } from './providers/GeminiProvider';

import { AiProvider } from './interface/AiProvider';

import { AiProviderType } from './interface/AiProviderType';
import { AnthropicProvider } from './providers/AnthropicProvider';
import { GroqProvider } from './providers/GroqProvider';
import { MistralProvider } from './providers/MistralProvider';
import { CustomProvider } from './providers/CustomProvider';
import { OpenRouterProvider } from './providers/OpenRouterProvider';

@Injectable()
export class AiProviderFactory {
  constructor(
    private readonly anthropic: AnthropicProvider,
    private readonly openai: OpenAIProvider,
    private readonly gemini: GeminiProvider,
    private readonly groq: GroqProvider,
    private readonly mistral: MistralProvider,
    private readonly custom: CustomProvider,
    private readonly openRouterProvider: OpenRouterProvider,
  ) {}

  getProvider(type: AiProviderType): AiProvider {
    const map: Record<AiProviderType, AiProvider> = {
      [AiProviderType.ANTHROPIC]: this.anthropic,
      [AiProviderType.OPENAI]: this.openai,
      [AiProviderType.GEMINI]: this.gemini,
      [AiProviderType.DEEPSEEK]: this.openai,
      [AiProviderType.GROQ]: this.groq,
      [AiProviderType.MISTRAL]: this.mistral,
      [AiProviderType.CUSTOM]: this.custom,
      [AiProviderType.OPENROUTER]: this.openRouterProvider,
    };

    const provider = map[type];
    if (!provider) throw new Error(`Provider no soportado: ${type}`);
    return provider;
  }
}
