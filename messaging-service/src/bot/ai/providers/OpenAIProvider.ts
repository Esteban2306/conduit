import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import {
  AiProvider,
  GenerateTextInput,
  GenerateTextResult,
  AnalyzeImageInput,
} from '../interface/AiProvider';

@Injectable()
export class OpenAIProvider implements AiProvider {
  readonly providerName = 'OPENAI';
  private readonly logger = new Logger(OpenAIProvider.name);

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    this.logger.debug({
      provider: this.providerName,
      model: input.model,
      baseUrl: input.baseUrl,
      apiKeyStart: input.apiKey.substring(0, 10),
    });

    const start = Date.now();
    const client = new OpenAI({
      apiKey: input.apiKey,
      ...(input.baseUrl && { baseURL: input.baseUrl }),
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
      temperature: input.temperature ?? 0.7,
    });

    const content = response.choices[0]?.message?.content ?? '';
    const tokensUsed = response.usage?.total_tokens ?? 0;

    return {
      content,
      tokensUsed,
      model: response.model,
      provider: this.providerName,
      latencyMs: Date.now() - start,
    };
  }

  async analyzeImage(input: AnalyzeImageInput): Promise<GenerateTextResult> {
    const start = Date.now();

    const client = new OpenAI({ apiKey: input.apiKey });

    const base64 = input.imageBuffer.toString('base64');
    const dataUrl = `data:${input.mimeType};base64,${base64}`;

    const response = await client.chat.completions.create({
      model: input.model,
      messages: [
        { role: 'system', content: input.systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: input.prompt },
          ],
        },
      ],
      max_tokens: input.maxTokens ?? 1024,
    });

    const content = response.choices[0]?.message?.content ?? '';
    const tokensUsed = response.usage?.total_tokens ?? 0;

    return {
      content,
      tokensUsed,
      model: response.model,
      provider: this.providerName,
      latencyMs: Date.now() - start,
    };
  }
}
