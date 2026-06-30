import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { AiModelRole } from '@prisma/client';
import { AiOrchestrator } from './AiOrchestrator';
import { BotConfigService } from '../config/BotConfigService';
import { AiModelSelectorService } from './AiModelSelectorService';
import { downloadMediaMessage, WAMessage } from '@whiskeysockets/baileys';
import { ImageOptimizer } from '../helper/ImageOptimizer';
import { PromptEngine } from '../prompt/PromptEngine';

export type ImageAnalysisStatus =
  | 'SUCCESS'
  | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_IMAGE'
  | 'ANALYSIS_ERROR';

export interface ImageAnalysisResult {
  status: ImageAnalysisStatus;
  valid: boolean;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  details?: string;
  raw?: string;
}

@Injectable()
export class ImageAnalysisService {
  private readonly logger = new Logger(ImageAnalysisService.name);

  private readonly DEFAULT_IMAGE_MODEL = 'nvidia/nemotron-nano-12b-v2-vl:free';
  private readonly OPENROUTER_URL =
    'https://openrouter.ai/api/v1/chat/completions';
  private readonly DEFAULT_IMAGE_PROVIDER = 'OPENROUTER';

  private readonly ANALYSIS_PROMPT =
    'Analiza esta imagen. Responde SOLO en JSON exacto sin texto adicional:\n{"valid":boolean,"confidence":"HIGH"|"MEDIUM"|"LOW","details":"descripción breve en español"}';

  constructor(
    private readonly orchestrator: AiOrchestrator,
    private readonly botConfigService: BotConfigService,
    private readonly selector: AiModelSelectorService,
    private readonly promptEngine: PromptEngine,
  ) {}

  async analyzeFromMessage(
    message: WAMessage,
    botConfigId: string,
    systemPrompt: string,
  ): Promise<ImageAnalysisResult> {
    this.logger.warn('IMAGE ANALYSIS SERVICE EJECUTADO');
    let imageBuffer: Buffer;
    try {
      imageBuffer = (await downloadMediaMessage(
        message,
        'buffer',
        {},
      )) as Buffer;
    } catch (err) {
      this.logger.error(`Error descargando imagen: ${err.message}`);
      return {
        status: 'ANALYSIS_ERROR',
        valid: false,
        confidence: 'LOW',
        details: 'No se pudo descargar la imagen',
      };
    }

    const originalKb = Math.round(imageBuffer.length / 1024);
    imageBuffer = await ImageOptimizer.optimize(imageBuffer);
    const optimizedKb = Math.round(imageBuffer.length / 1024);
    this.logger.log(`Imagen: ${originalKb}KB → ${optimizedKb}KB`);

    const mimeType = 'image/jpeg';

    const builtPrompt = await this.promptEngine.buildImagePrompt(botConfigId);
    const promptText = builtPrompt.systemPrompt;

    try {
      const imageModel = await this.selector.selectModel(
        botConfigId,
        AiModelRole.IMAGE_ANALYSIS,
      );
      let result: string;

      if (imageModel) {
        this.logger.log(
          `Usando modelo configurado: ${imageModel.provider}/${imageModel.model}`,
        );
        const aiResult = await this.orchestrator.analyzeImage({
          botConfigId,
          systemPrompt: promptText,
          prompt: promptText,
          imageBuffer,
          mimeType,
          model: imageModel.model,
          apiKey: imageModel.apiKey,
        });
        result = aiResult.content;
      } else {
        this.logger.log(
          'Sin modelo IMAGE_ANALYSIS configurado. Usando OpenRouter/Nemotron por defecto',
        );
        result = await this.analyzeWithOpenRouter(
          imageBuffer,
          mimeType,
          promptText,
        );
      }
      return this.parseAnalysisResult(result);
    } catch (err) {
      const isProviderUnavailable =
        err.message?.includes('503') ||
        err.message?.includes('Service Unavailable') ||
        err.message?.includes('429') ||
        err.message?.includes('high demand') ||
        err.message?.includes('Todos los modelos fallaron');

      if (isProviderUnavailable) {
        this.logger.warn(
          `Proveedor de imagen no disponible temporalmente: ${err.message}`,
        );
        return {
          status: 'PROVIDER_UNAVAILABLE',
          valid: false,
          confidence: 'LOW',
          details: 'Proveedor temporalmente saturado',
        };
      }

      this.logger.error(`Error analizando imagen: ${err.message}`);
      return {
        status: 'ANALYSIS_ERROR',
        valid: false,
        confidence: 'LOW',
        details: 'Error interno al analizar la imagen',
      };
    }
  }

  private async analyzeWithOpenRouter(
    imageBuffer: Buffer,
    mimeType: string,
    promptText: string,
  ): Promise<string> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY no configurada en .env');
    }

    const response = await fetch(this.OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: this.DEFAULT_IMAGE_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: promptText },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${imageBuffer.toString('base64')}`,
                },
              },
            ],
          },
        ],
        max_tokens: 150,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 503 || response.status === 429) {
        throw new Error(`PROVIDER_UNAVAILABLE:${response.status} ${body}`);
      }
      throw new Error(`OpenRouter error ${response.status}: ${body}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? '';
    const tokens = data.usage?.total_tokens ?? 0;
    this.logger.log(
      `OpenRouter/Nemotron análisis completado | tokens: ${tokens}`,
    );

    return content;
  }

  private parseAnalysisResult(raw: string): ImageAnalysisResult {
    try {
      const cleaned = raw.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      return {
        status: 'SUCCESS',
        valid: Boolean(parsed.valid),
        raw,
        confidence: parsed.confidence ?? 'MEDIUM',
        details: parsed.details,
      };
    } catch (err) {
      this.logger.warn(`No se pudo parsear respuesta de imagen: ${raw}`);
      const looksPositive = /válido|correcto|confirmado|aprobado/i.test(raw);
      return {
        status: 'SUCCESS',
        valid: looksPositive,
        confidence: 'LOW',
        details: raw.slice(0, 150),
        raw,
      };
    }
  }
}
