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
import { resolveModel } from '../helper/model-resolver';
import { ImageOptimizer } from '../helper/ImageOptimizer';

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
      AiModelRole.CONVERSATION,
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

        this.logger.debug({
          provider: config.provider,
          dbModel: config.model,
        });

        const model = resolveModel(
          config.provider as AiProviderType,
          config.model,
        );

        this.logger.debug({
          provider: config.provider,
          resolvedModel: model,
        });

        this.logger.debug({
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
        });

        const result = await provider.generateText({
          prompt: fullPrompt,
          systemPrompt: input.systemPrompt,
          history: input.history,
          model,
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

    const optimizedBuffer = await ImageOptimizer.optimize(input.imageBuffer);

    return this.executeWithFallback(
      modelConfig,
      input.botConfigId,
      AiModelRole.IMAGE_ANALYSIS,
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
    initialModel: AiModelConfig,
    botConfigId: string,
    role: AiModelRole,
    execute: (
      config: AiModelConfig,
    ) => Promise<{ result: GenerateTextResult; config: AiModelConfig }>,
  ): Promise<OrchestratorResult> {
    const start = Date.now();
    const attempted = new Set<string>();

    let currentModel: AiModelConfig | null = initialModel;

    while (currentModel) {
      attempted.add(currentModel.id);

      try {
        const { result, config } = await execute(currentModel);
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
          `Fallo en ${currentModel.provider}/${currentModel.model}: ${error.message}`,
        );

        await this.selector.markUnavailable(currentModel.id);

        const next = await this.selector.selectModel(botConfigId, role);

        if (!next || attempted.has(next.id)) {
          throw new Error(
            `Todos los modelos fallaron. Último error (${currentModel.provider}): ${error.message}`,
          );
        }

        this.logger.warn(
          `Fallback: ${currentModel.provider} → ${next.provider}/${next.model}`,
        );
        currentModel = next;
      }
    }

    throw new Error('Sin modelos de IA disponibles');
  }

  private buildContextBlock(
    content: ConversationContext,
    summary: string | null,
  ): string | null {
    const parts: string[] = [];

    if (summary) {
      parts.push(`Resumen: ${summary}`);
    }

    const compactContext = this.extractRelevantContext(content);
    if (compactContext) {
      parts.push(`Contexto: ${compactContext}`);
    }

    return parts.length > 0 ? parts.join('\n') : null;
  }

  private extractRelevantContext(content: ConversationContext): string | null {
    const EXCLUDED_KEYS = new Set([
      'retryCount',
      'imageVerified',
      'lastImageAnalysis',
      'processingAt',
      'lockedBy',
    ]);

    const PRIORITY_KEYS = [
      'currentStep',
      'lastIntent',
      'clientName',
      'clientEmail',
      'orderStatus',
      'appointmentDate',
      'pendingAction',
      'collectedData',
    ];

    const result: string[] = [];

    for (const key of PRIORITY_KEYS) {
      const value = (content as any)[key];
      if (value !== undefined && value !== null && value !== '') {
        result.push(`${key}=${this.compactValue(value)}`);
      }
    }

    const prioritySet = new Set(PRIORITY_KEYS);
    for (const [key, value] of Object.entries(content)) {
      if (EXCLUDED_KEYS.has(key)) continue;
      if (prioritySet.has(key)) continue;
      if (value === undefined || value === null || value === '') continue;

      result.push(`${key}=${this.compactValue(value)}`);
    }

    if (result.length === 0) return null;
    const joined = result.join(', ');
    return joined.length > 800 ? joined.slice(0, 800) + '…' : joined;
  }

  private compactValue(value: unknown): string {
    if (typeof value === 'string') return value.slice(0, 100);
    if (typeof value === 'number' || typeof value === 'boolean')
      return String(value);
    if (Array.isArray(value)) {
      return value
        .slice(0, 3)
        .map((v) => this.compactValue(v))
        .join('|');
    }
    if (typeof value === 'object') {
      return Object.entries(value as Record<string, unknown>)
        .slice(0, 4)
        .map(([k, v]) => `${k}:${this.compactValue(v)}`)
        .join(';');
    }

    return String(value).slice(0, 100);
  }
}
