import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import {
  AiProvider,
  GenerateTextInput,
  GenerateTextResult,
  AnalyzeImageInput,
} from '../interface/AiProvider';

@Injectable()
export class AnthropicProvider implements AiProvider {
  readonly providerName = 'ANTHROPIC';
  private readonly logger = new Logger(AnthropicProvider.name);

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const start = Date.now();

    const client = new Anthropic({ apiKey: input.apiKey });

    const messages: Anthropic.MessageParam[] = (input.history ?? []).map(
      (h) => ({
        role: h.role === 'user' ? 'user' : 'assistant',
        content: h.content,
      }),
    );

    messages.push({ role: 'user', content: input.prompt });

    const response = await client.messages.create({
      model: input.model,
      max_tokens: input.maxTokens ?? 1024,
      system: input.systemPrompt,
      messages,
    });

    const content = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as Anthropic.TextBlock).text)
      .join('');

    const tokensUsed =
      response.usage.input_tokens + response.usage.output_tokens;

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

    const client = new Anthropic({ apiKey: input.apiKey });

    const response = await client.messages.create({
      model: input.model,
      max_tokens: input.maxTokens ?? 1024,
      system: input.systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: input.mimeType as
                  | 'image/jpeg'
                  | 'image/png'
                  | 'image/webp'
                  | 'image/gif',
                data: input.imageBuffer.toString('base64'),
              },
            },
            { type: 'text', text: input.prompt },
          ],
        },
      ],
    });

    const content = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as Anthropic.TextBlock).text)
      .join('');

    const tokensUsed =
      response.usage.input_tokens + response.usage.output_tokens;

    return {
      content,
      tokensUsed,
      model: response.model,
      provider: this.providerName,
      latencyMs: Date.now() - start,
    };
  }
}
