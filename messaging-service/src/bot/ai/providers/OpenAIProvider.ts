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
  readonly supportsTools = true;
  private readonly logger = new Logger(OpenAIProvider.name);
  private readonly DEFAULT_MAX_TOOL_ITERATIONS = 3;

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
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
        temperature: input.temperature ?? 0.7,
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
            `Argumentos de tool call "${call.function.name}" no son JSON válido: ${call.function.arguments}`,
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
