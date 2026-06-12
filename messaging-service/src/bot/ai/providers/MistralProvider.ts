import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import {
  AiProvider,
  GenerateTextInput,
  GenerateTextResult,
  AnalyzeImageInput,
} from '../interface/AiProvider';

@Injectable()
export class MistralProvider implements AiProvider {
  readonly providerName = 'MISTRAL';

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const start = Date.now();
    const client = new OpenAI({
      apiKey: input.apiKey,
      baseURL: 'https://api.mistral.ai/v1',
    });

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: input.systemPrompt },
      ...(input.history ?? []).map((h) => ({
        role: h.role as 'user' | 'assistant',
        content: h.content,
      })),
      { role: 'user', content: input.prompt },
    ];

    const response = await client.chat.completions.create({
      model: input.model,
      messages,
      max_tokens: input.maxTokens ?? 1024,
    });

    return {
      content: response.choices[0]?.message?.content ?? '',
      tokensUsed: response.usage?.total_tokens ?? 0,
      model: response.model,
      provider: this.providerName,
      latencyMs: Date.now() - start,
    };
  }

  async analyzeImage(input: AnalyzeImageInput): Promise<GenerateTextResult> {
    throw new Error(
      'Mistral no soporta análisis de imágenes. Configura otro modelo para IMAGE_ANALYSIS.',
    );
  }
}
