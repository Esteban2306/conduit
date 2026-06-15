import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AiModelConfig, AiModelRole } from '@prisma/client';
import { AiModelSelectorService } from './AiModelSelectorService';
import { AiProviderFactory } from './AiProviderFactory';
import { ConversationContext } from '../conversation/interfaces/ConversationContext';
import { AnalyzeImageInput, GenerateTextResult } from './interface/AiProvider';
import {
  GenerateResponseInput,
  OrchestratorResult,
} from './interface/AiOrchestator.types';
import { AiProviderType } from './interface/AiProviderType';

@Injectable()
export class AiOrchestrator {
  private readonly logger = new Logger(AiOrchestrator.name);

  constructor(
    private readonly selector: AiModelSelectorService,
    private readonly providerFactory: AiProviderFactory,
  ) {}

  async generateResponse(
    input: GenerateResponseInput,
  ): Promise<OrchestratorResult> {
    const modelConfig = await this.selector.selectModel(
      input.botConfigId,
      AiModelRole.CONVERSATION,
    );

    if (!modelConfig) {
      throw new BadRequestException(
        'Sin modelos de IA disponibles para conversación',
      );
    }

    return this.executeWithFallback(
      modelConfig,
      input.botConfigId,
      async (config) => {
        const provider = this.providerFactory.getProvider(
          config.provider as AiProviderType,
        );

        const contextBlock = this.buildContextBlock(
          input.context,
          input.summary ?? '',
        );
        const fullPrompt = contextBlock
          ? `${contextBlock}\n\n${input.userMessage}`
          : input.userMessage;

        const apiKey = await this.selector.resolveApiKey(config);

        console.log(config.model);
        console.log(config.provider);
        console.log(apiKey);

        this.logger.debug({
          provider: config.provider,
          model: config.model,
          apiKeyStart: apiKey.substring(0, 8),
        });

        const result = await provider.generateText({
          prompt: fullPrompt,
          systemPrompt: input.systemPrompt,
          history: input.history,
          model: config.model,
          apiKey,
          baseUrl: config.baseUrl ?? '',
          maxTokens: 1024,
          temperature: 0.7,
        });

        return { result, config };
      },
    );
  }

  async analyzeImage(input: AnalyzeImageInput): Promise<OrchestratorResult> {
    const modelConfig = await this.selector.selectModel(
      input.botConfigId,
      AiModelRole.IMAGE_ANALYSIS,
    );

    if (!modelConfig) {
      throw new BadRequestException(
        'Sin modelos disponibles para análisis de imágenes',
      );
    }

    return this.executeWithFallback(
      modelConfig,
      input.botConfigId,
      async (config) => {
        const provider = this.providerFactory.getProvider(
          config.provider as AiProviderType,
        );

        const result = await provider.analyzeImage({
          prompt: input.prompt,
          botConfigId: input.botConfigId,
          systemPrompt: input.systemPrompt,
          imageBuffer: input.imageBuffer,
          mimeType: input.mimeType,
          model: config.model,
          apiKey: await this.selector.resolveApiKey(config),
          baseUrl: config.baseUrl ?? undefined,
          maxTokens: 1024,
        });

        return { result, config };
      },
    );
  }

  private async executeWithFallback(
    modelConfig: AiModelConfig,
    botConfigId: string,
    execute: (
      config: AiModelConfig,
    ) => Promise<{ result: GenerateTextResult; config: AiModelConfig }>,
  ): Promise<OrchestratorResult> {
    const start = Date.now();

    try {
      const { result, config } = await execute(modelConfig);

      await this.selector.recordUsage(config.id, result.tokensUsed);

      this.logger.log(
        `IA: ${config.provider}/${config.model} | tokens: ${result.tokensUsed} | ${result.latencyMs}ms`,
      );

      return {
        content: result.content,
        tokensUsed: result.tokensUsed,
        modelUsed: result.model,
        providerUsed: result.provider,
        latencyMs: result.latencyMs,
        modelConfigId: config.id,
      };
    } catch (error) {
      this.logger.error(
        `Fallo en ${modelConfig.provider}/${modelConfig.model}: ${error.message}`,
      );

      await this.selector.markUnavailable(modelConfig.id);

      const fallbackConfig = await this.selector.selectModel(
        botConfigId,
        AiModelRole.CONVERSATION,
      );

      if (!fallbackConfig || fallbackConfig.id === modelConfig.id) {
        throw new Error(
          `Sin modelos disponibles después de fallo en ${modelConfig.provider}. Error: ${error.message}`,
        );
      }

      this.logger.warn(
        `usando fallback: ${fallbackConfig.provider}/${fallbackConfig.model}`,
      );

      const { result, config } = await execute(fallbackConfig);

      await this.selector.recordUsage(config.id, result.tokensUsed);

      return {
        content: result.content,
        tokensUsed: result.tokensUsed,
        modelUsed: result.model,
        providerUsed: result.provider,
        latencyMs: Date.now() - start,
        modelConfigId: config.id,
      };
    }
  }

  private buildContextBlock(
    content: ConversationContext,
    summary: string | null,
  ): string | null {
    const parts: string[] = [];

    if (summary) {
      parts.push(`Resumen de la conversación hasta ahora:\n${summary}`);
    }

    const relevantContext = Object.entries(content).filter(
      ([key, value]) =>
        value !== undefined && value !== null && !['retryCount'].includes(key),
    );

    if (relevantContext.length > 0) {
      const contextText = relevantContext
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join('\n');
      parts.push(`Estado actual de la conversación:\n${contextText}`);
    }

    return parts.length > 0 ? parts.join('\n\n') : null;
  }
}
