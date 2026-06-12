import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import {
  AiProvider,
  GenerateTextInput,
  GenerateTextResult,
  AnalyzeImageInput,
} from '../interface/AiProvider';

@Injectable()
export class CustomProvider implements AiProvider {
  readonly providerName = 'CUSTOM';

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    if (!input.baseUrl)
      throw new Error('CUSTOM provider requiere baseUrl en AiModelConfig');
    const start = Date.now();

    const client = new OpenAI({ apiKey: input.apiKey, baseURL: input.baseUrl });

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
      'CUSTOM provider no soporta análisis de imágenes por defecto.',
    );
  }
}
