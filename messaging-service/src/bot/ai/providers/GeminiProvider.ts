import { Injectable, Logger } from '@nestjs/common';
import {
  GoogleGenerativeAI,
  FunctionDeclarationSchema,
  Content,
  Part,
} from '@google/generative-ai';
import {
  AiProvider,
  GenerateTextInput,
  GenerateTextResult,
  AnalyzeImageInput,
} from '../interface/AiProvider';

@Injectable()
export class GeminiProvider implements AiProvider {
  readonly providerName = 'GEMINI';
  readonly supportsTools = true;
  private readonly logger = new Logger(GeminiProvider.name);
  private readonly DEFAULT_MAX_TOOL_ITERATIONS = 3;

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const start = Date.now();
    const genAI = new GoogleGenerativeAI(input.apiKey);

    const tools = input.tools?.length
      ? [
          {
            functionDeclarations: input.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parametersSchema as FunctionDeclarationSchema,
            })),
          },
        ]
      : undefined;

    const model = genAI.getGenerativeModel({
      model: input.model,
      systemInstruction: input.systemPrompt,
      ...(tools ? { tools } : {}),
    });

    const rawHistory = input.history ?? [];
    const firstUserIndex = rawHistory.findIndex((h) => h.role === 'user');
    const safeHistory =
      firstUserIndex >= 0 ? rawHistory.slice(firstUserIndex) : [];

    const geminiHistory: Content[] = [];
    for (const msg of safeHistory) {
      const role = msg.role === 'user' ? 'user' : 'model';
      const last = geminiHistory[geminiHistory.length - 1];
      if (last && last.role === role) {
        (last.parts[0] as { text: string }).text += '\n' + msg.content;
      } else {
        geminiHistory.push({ role, parts: [{ text: msg.content }] });
      }
    }

    const chat = model.startChat({ history: geminiHistory });

    const toolCallsExecuted: GenerateTextResult['toolCallsExecuted'] = [];
    let totalTokens = 0;
    const maxIterations =
      input.maxToolIterations ?? this.DEFAULT_MAX_TOOL_ITERATIONS;

    let nextMessage: string | Part[] = input.prompt;

    for (let iteration = 0; iteration <= maxIterations; iteration++) {
      const result = await chat.sendMessage(nextMessage);
      const response = result.response;

      totalTokens += response.usageMetadata?.totalTokenCount ?? 0;

      const functionCalls = response.functionCalls();

      if (!functionCalls?.length || !input.toolExecutor) {
        return {
          content: response.text(),
          tokensUsed: totalTokens,
          model: input.model,
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
          model: input.model,
          provider: this.providerName,
          latencyMs: Date.now() - start,
          toolCallsExecuted,
        };
      }

      const functionResponseParts: Part[] = [];
      for (const call of functionCalls) {
        const execResult = await input.toolExecutor({
          name: call.name,
          arguments: call.args as Record<string, unknown>,
        });

        toolCallsExecuted.push({
          name: call.name,
          arguments: call.args as Record<string, unknown>,
          ok: execResult.ok,
        });

        functionResponseParts.push({
          functionResponse: {
            name: call.name,
            response: execResult.content,
          },
        });
      }

      nextMessage = functionResponseParts;
    }

    throw new Error('Bucle de tool calling terminó sin resultado.');
  }

  async analyzeImage(input: AnalyzeImageInput): Promise<GenerateTextResult> {
    const start = Date.now();
    const genAI = new GoogleGenerativeAI(input.apiKey);
    const model = genAI.getGenerativeModel({ model: input.model });

    const result = await model.generateContent([
      input.prompt,
      {
        inlineData: {
          mimeType: input.mimeType,
          data: input.imageBuffer.toString('base64'),
        },
      },
    ]);

    const content = result.response.text();
    const tokensUsed = result.response.usageMetadata?.totalTokenCount ?? 0;

    return {
      content,
      tokensUsed,
      model: input.model,
      provider: this.providerName,
      latencyMs: Date.now() - start,
    };
  }
}
