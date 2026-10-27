import { Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import {
  AiProvider,
  GenerateTextInput,
  GenerateTextResult,
  AnalyzeImageInput,
  ReasoningLevel,
  TokenUsage,
} from '../interface/AiProvider';
import { AI_CALL_TIMEOUT_MS } from '../turn-budget';

const CACHE: Anthropic.CacheControlEphemeral = { type: 'ephemeral' };

export function billableTokens(usage: TokenUsage): number {
  return (
    usage.input +
    usage.cacheWrite +
    Math.ceil(usage.cacheRead / 10) +
    usage.output
  );
}

export function reasoningParams(
  mode: ReasoningLevel | undefined,
): Pick<
  Anthropic.MessageCreateParamsNonStreaming,
  'thinking' | 'output_config'
> {
  if (mode === 'OFF') return { thinking: { type: 'disabled' } };
  if (mode === 'LOW') return { output_config: { effort: 'low' } };
  return {};
}

@Injectable()
export class AnthropicProvider implements AiProvider {
  readonly providerName = 'ANTHROPIC';
  readonly supportsTools = true;
  private readonly logger = new Logger(AnthropicProvider.name);
  private readonly DEFAULT_MAX_TOOL_ITERATIONS = 3;
  private readonly REQUEST_TIMEOUT_MS = AI_CALL_TIMEOUT_MS;

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const start = Date.now();
    const client = new Anthropic({
      apiKey: input.apiKey,
      timeout: this.REQUEST_TIMEOUT_MS,
      maxRetries: 0,
    });

    const messages: Anthropic.MessageParam[] = (input.history ?? []).map(
      (h) => ({
        role: h.role === 'user' ? 'user' : 'assistant',
        content: h.content,
      }),
    );
    messages.push({ role: 'user', content: input.prompt });

    const system: string | Anthropic.TextBlockParam[] = input.systemBlocks
      ? [
          {
            type: 'text',
            text: input.systemBlocks.cacheable,
            cache_control: CACHE,
          },
          ...(input.systemBlocks.dynamic
            ? [{ type: 'text' as const, text: input.systemBlocks.dynamic }]
            : []),
        ]
      : input.systemPrompt;

    const tools: Anthropic.Tool[] | undefined = input.tools?.map(
      (t, index, all) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parametersSchema as Anthropic.Tool.InputSchema,
        ...(input.systemBlocks && index === all.length - 1
          ? { cache_control: CACHE }
          : {}),
      }),
    );

    const toolCallsExecuted: GenerateTextResult['toolCallsExecuted'] = [];
    const usage: TokenUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 0,
    };
    const maxIterations =
      input.maxToolIterations ?? this.DEFAULT_MAX_TOOL_ITERATIONS;

    this.logger.debug(
      `Solicitud | system ${JSON.stringify(system).length}c | ${tools?.length ?? 0} herramientas ${JSON.stringify(tools ?? []).length}c | historial ${messages.length} mensajes ${JSON.stringify(messages).length}c`,
    );

    for (let iteration = 0; iteration <= maxIterations; iteration++) {
      const response = await client.messages.create({
        model: input.model,
        max_tokens: input.maxTokens ?? 1024,
        system,
        messages,
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...reasoningParams(input.reasoningMode),
      });

      usage.input += response.usage.input_tokens;
      usage.output += response.usage.output_tokens;
      usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
      usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;
      usage.thinking +=
        response.usage.output_tokens_details?.thinking_tokens ?? 0;

      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      const cutOffMidTool = response.stop_reason === 'max_tokens';
      if (toolUseBlocks.length === 0 || !input.toolExecutor || cutOffMidTool) {
        const content = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');

        return {
          content,
          tokensUsed: billableTokens(usage),
          usage,
          stopReason: response.stop_reason,
          model: response.model,
          provider: this.providerName,
          latencyMs: Date.now() - start,
          llmCalls: iteration + 1,
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
          tokensUsed: billableTokens(usage),
          usage,
          stopReason: response.stop_reason,
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
    const client = new Anthropic({
      apiKey: input.apiKey,
      timeout: this.REQUEST_TIMEOUT_MS,
      maxRetries: 0,
    });

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
