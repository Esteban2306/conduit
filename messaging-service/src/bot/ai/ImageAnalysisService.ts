import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { AiModelRole, AiProvider } from '@prisma/client';
import { AiOrchestrator } from './AiOrchestrator';
import { BotConfigService } from '../config/BotConfigService';
import { AiModelSelectorService } from './AiModelSelectorService';
import { downloadMediaMessage, WAMessage } from '@whiskeysockets/baileys';

export interface ImageAnalysisResult {
  valid: boolean;
  raw: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  details?: string;
}

@Injectable()
export class ImageAnalysisService {
  private readonly logger = new Logger(ImageAnalysisService.name);

  private readonly DEFAULT_IMAGE_MODEL = 'gemini-1.5-flash';
  private readonly DEFAULT_IMAGE_PROVIDER = AiProvider.GEMINI;

  constructor(
    private readonly orchestrator: AiOrchestrator,
    private readonly botConfigService: BotConfigService,
    private readonly selector: AiModelSelectorService,
  ) {}

  async analyzeFromMessage(
    message: WAMessage,
    botConfigId: string,
    systemPrompt: string,
  ): Promise<ImageAnalysisResult> {
    const imageBuffer = (await downloadMediaMessage(
      message,
      'buffer',
      {},
    )) as Buffer;

    const mimeType = message.message?.imageMessage?.mimetype ?? 'image/jpeg';

    const analysisPrompt = `Analiza esta imagen cuidadosamente. 
        Responde SOLO en formato JSON con esta estructura exacta:
        {
        "valid": boolean,
        "confidence": "HIGH" | "MEDIUM" | "LOW",
        "details": "descripción breve de lo que ves"
        }
        No incluyas texto fuera del JSON.`;

    try {
      const imageModel = await this.selector.selectModel(
        botConfigId,
        AiModelRole.IMAGE_ANALYSIS,
      );
      let result: string;

      if (imageModel) {
        const aiResult = await this.orchestrator.analyzeImage({
          botConfigId,
          systemPrompt,
          prompt: analysisPrompt,
          imageBuffer,
          mimeType,
          model: imageModel.model,
          apiKey: imageModel.apiKey,
        });
        result = aiResult.content;
      } else {
        result = await this.analyzeWithDefaultGemini(
          imageBuffer,
          mimeType,
          systemPrompt,
          analysisPrompt,
        );
      }
      return this.parseAnalysisResult(result);
    } catch (err) {
      this.logger.error(`Error analizando imagen: ${err.message}`);
      return {
        valid: false,
        raw: err.message,
        confidence: 'LOW',
        details: 'No se pudo analizar la imagen',
      };
    }
  }

  private async analyzeWithDefaultGemini(
    imageBuffer: Buffer,
    mimeType: string,
    systemPrompt: string,
    prompt: string,
  ): Promise<string> {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const apiKey = process.env.GEMINI_DEFAULT_API_KEY;

    if (!apiKey) {
      throw new Error(
        'GEMINI_DEFAULT_API_KEY no configurada. Agrega al .env o configura un modelo IMAGE_ANALYSIS en el bot.',
      );
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: this.DEFAULT_IMAGE_MODEL,
      systemInstruction: systemPrompt,
    });

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType,
          data: imageBuffer.toString('base64'),
        },
      },
    ]);

    return result.response.text();
  }

  private parseAnalysisResult(raw: string): ImageAnalysisResult {
    try {
      const cleaned = raw.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      return {
        valid: Boolean(parsed.valid),
        raw,
        confidence: parsed.confidence ?? 'MEDIUM',
        details: parsed.details,
      };
    } catch (err) {
      this.logger.warn(`No se pudo parsear respuesta de la imgen: ${raw}`);
      const looksPositive = /válido|correcto|confirmado|aprobado/i.test(raw);
      return {
        valid: looksPositive,
        raw,
        confidence: 'LOW',
        details: raw.slice(0, 200),
      };
    }
  }
}
