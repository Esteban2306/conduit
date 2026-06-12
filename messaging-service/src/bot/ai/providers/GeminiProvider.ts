import { Injectable, Logger } from '@nestjs/common';
import {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
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
  private readonly logger = new Logger(GeminiProvider.name);

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const start = Date.now();

    const genAI = new GoogleGenerativeAI(input.apiKey);
    const model = genAI.getGenerativeModel({
      model: input.model,
      systemInstruction: input.systemPrompt,
    });

    // Gemini usa un formato de historial diferente
    const history = (input.history ?? []).map((h) => ({
      role: h.role === 'user' ? 'user' : 'model',
      parts: [{ text: h.content }],
    }));

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(input.prompt);
    const response = result.response;

    const content = response.text();
    const tokensUsed = response.usageMetadata?.totalTokenCount ?? 0;

    return {
      content,
      tokensUsed,
      model: input.model,
      provider: this.providerName,
      latencyMs: Date.now() - start,
    };
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
