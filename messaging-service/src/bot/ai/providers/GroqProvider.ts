import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import {
  AiProvider,
  GenerateTextInput,
  GenerateTextResult,
  AnalyzeImageInput,
} from '../interface/AiProvider';

@Injectable()
export class GroqProvider implements AiProvider {
  readonly providerName = 'GROQ';
  readonly supportsTools = true;
  private readonly logger = new Logger(GroqProvider.name);
  private readonly DEFAULT_MAX_TOOL_ITERATIONS = 3;

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const start = Date.now();
    const client = new OpenAI({
      apiKey: input.apiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    });

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: input.systemPrompt },
      ...(input.history ?? []).map((h) => ({
        role: h.role as 'user' | 'assistant',
        content: h.content,
      })),
      { role: 'user', content: input.prompt },
    ];

    const tools: OpenAI.Chat.ChatCompletionTool[] | undefined =
      input.tools?.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parametersSchema,
        },
      }));

    const toolCallsExecuted: GenerateTextResult['toolCallsExecuted'] = [];
    let totalTokens = 0;
    const maxIterations =
      input.maxToolIterations ?? this.DEFAULT_MAX_TOOL_ITERATIONS;

    for (let iteration = 0; iteration <= maxIterations; iteration++) {
      const response = await client.chat.completions.create({
        model: input.model,
        messages,
        max_tokens: input.maxTokens ?? 1024,
        ...(tools && tools.length > 0 ? { tools } : {}),
      });

      totalTokens += response.usage?.total_tokens ?? 0;

      const choice = response.choices[0];
      const toolCalls = choice?.message?.tool_calls ?? [];

      if (toolCalls.length === 0 || !input.toolExecutor) {
        return {
          content: choice?.message?.content ?? '',
          tokensUsed: totalTokens,
          model: response.model,
          provider: this.providerName,
          latencyMs: Date.now() - start,
          toolCallsExecuted,
        };
      }

      if (iteration === maxIterations) {
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

      messages.push(choice.message);

      for (const call of toolCalls) {
        if (call.type !== 'function') {
          this.logger.warn(
            `Tool call de tipo "${call.type}" no soportado — se omite. Solo se soportan tool calls de tipo "function".`,
          );
          continue;
        }
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          this.logger.warn(
            `Argumentos de tool call "${call.function.name}" no son JSON válido.`,
          );
        }

        const execResult = await input.toolExecutor({
          name: call.function.name,
          arguments: args,
        });

        toolCallsExecuted.push({
          name: call.function.name,
          arguments: args,
          ok: execResult.ok,
        });

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(execResult.content),
        });
      }
    }

    throw new Error('Bucle de tool calling terminó sin resultado.');
  }

  async analyzeImage(): Promise<GenerateTextResult> {
    throw new Error(
      'Groq no soporta análisis de imágenes. Configura otro modelo para IMAGE_ANALYSIS.',
    );
  }
}
