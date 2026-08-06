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
  readonly supportsTools = true;
  private readonly logger = new Logger(AnthropicProvider.name);
  private readonly DEFAULT_MAX_TOOL_ITERATIONS = 3;

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

    const tools: Anthropic.Tool[] | undefined = input.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parametersSchema as Anthropic.Tool.InputSchema,
    }));

    const toolCallsExecuted: GenerateTextResult['toolCallsExecuted'] = [];
    let totalTokens = 0;
    const maxIterations =
      input.maxToolIterations ?? this.DEFAULT_MAX_TOOL_ITERATIONS;

    for (let iteration = 0; iteration <= maxIterations; iteration++) {
      const response = await client.messages.create({
        model: input.model,
        max_tokens: input.maxTokens ?? 1024,
        system: input.systemPrompt,
        messages,
        ...(tools && tools.length > 0 ? { tools } : {}),
      });

      totalTokens += response.usage.input_tokens + response.usage.output_tokens;

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      if (toolUseBlocks.length === 0 || !input.toolExecutor) {
        const content = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');

        return {
          content,
          tokensUsed: totalTokens,
          model: response.model,
          provider: this.providerName,
          latencyMs: Date.now() - start,
          toolCallsExecuted,
        };
      }

      if (iteration === maxIterations) {
        this.logger.warn(
          `Se alcanzó el máximo de ${maxIterations} iteraciones de tool calling — se corta el ciclo.`,
        );
        return {
          content:
            'No pude completar la solicitud en este momento. Un miembro del equipo te contactará pronto.',
          tokensUsed: totalTokens,
          model: response.model,
          provider: this.providerName,
          latencyMs: Date.now() - start,
          toolCallsExecuted,
        };
      }

      messages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        const execResult = await input.toolExecutor({
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });

        toolCallsExecuted.push({
          name: block.name,
          arguments: block.input as Record<string, unknown>,
          ok: execResult.ok,
        });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(execResult.content),
          is_error: !execResult.ok,
        });
      }

      messages.push({ role: 'user', content: toolResults });
    }

    throw new Error('Bucle de tool calling terminó sin resultado.');
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
