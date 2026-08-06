import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  AiProvider,
  AnalyzeImageInput,
  GenerateTextInput,
  GenerateTextResult,
} from '../interface/AiProvider';
import { ImageOptimizer } from 'src/bot/helper/ImageOptimizer';

@Injectable()
export class OpenRouterProvider implements AiProvider {
  readonly providerName = 'OPENROUTER';

  private readonly logger = new Logger(OpenRouterProvider.name);
  readonly supportsTools = false;

  private readonly BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';
  private readonly DEFAULT_IMAGE_MODEL = 'nvidia/nemotron-nano-12b-v2-vl:free';

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    if (input.tools?.length) {
      this.logger.warn(
        `${this.providerName} no soporta tool calling — se ignoran ${input.tools.length} tool(s) definida(s) para este bot.`,
      );
    }
    const start = Date.now();
    const apiKey = input.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY no configurada');

    const messages: any[] = [];
    if (input.systemPrompt) {
      messages.push({ role: 'system', content: input.systemPrompt });
    }
    if (input.history?.length) {
      messages.push(
        ...input.history.map((h) => ({ role: h.role, content: h.content })),
      );
    }
    messages.push({ role: 'user', content: input.prompt });

    const response = await fetch(this.BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: input.model ?? this.DEFAULT_IMAGE_MODEL,
        messages,
        max_tokens: input.maxTokens ?? 512,
        temperature: input.temperature ?? 0.7,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      if (response.status === 503 || response.status === 429) {
        throw new Error(`PROVIDER_UNAVAILABLE:${response.status}`);
      }
      throw new BadRequestException(
        `OpenRouter generateText error ${response.status}: ${errorBody}`,
      );
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? '';
    this.logger.warn({
      contentLength: content.length,
      content,
    });
    const tokensUsed = data.usage?.total_tokens ?? 0;

    return {
      content,
      tokensUsed,
      model: input.model ?? this.DEFAULT_IMAGE_MODEL,
      provider: 'OPENROUTER',
      latencyMs: Date.now() - start,
    };
  }

  async analyzeImage(input: AnalyzeImageInput): Promise<GenerateTextResult> {
    const start = Date.now();
    const apiKey = input.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY no configurada');

    const messages: any[] = [];
    if (input.systemPrompt?.trim()) {
      messages.push({ role: 'system', content: input.systemPrompt });
    }
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: input.prompt },
        {
          type: 'image_url',
          image_url: {
            url: `data:${input.mimeType ?? 'image/jpeg'};base64,${input.imageBuffer.toString('base64')}`,
          },
        },
      ],
    });

    const response = await fetch(this.BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.DEFAULT_IMAGE_MODEL,
        messages,
        max_tokens: input.maxTokens ?? 200,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      if (response.status === 503 || response.status === 429) {
        throw new Error(`PROVIDER_UNAVAILABLE:${response.status}`);
      }
      throw new Error(
        `OpenRouter analyzeImage error ${response.status}: ${errorBody}`,
      );
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? '';
    this.logger.warn({
      contentLength: content.length,
      content,
    });
    const tokensUsed = data.usage?.total_tokens ?? 0;

    this.logger.log(
      `OpenRouter/Nemotron | tokens: ${tokensUsed} | ${Date.now() - start}ms`,
    );

    return {
      content,
      tokensUsed,
      model: this.DEFAULT_IMAGE_MODEL,
      provider: 'OPENROUTER',
      latencyMs: Date.now() - start,
    };
  }
}
