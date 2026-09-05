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
import { AiErrorClassifier } from './AiErrorClassifier';
import { AiErrorAction, ClassifiedAiError } from './interface/AiError';

@Injectable()
export class AiOrchestrator {
  private readonly logger = new Logger(AiOrchestrator.name);

  constructor(
    private readonly selector: AiModelSelectorService,
    private readonly providerFactory: AiProviderFactory,
    private readonly errorClassifier: AiErrorClassifier,
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

        const apiKey = await this.selector.resolveApiKey(config);

        const model = resolveModel(
          config.provider as AiProviderType,
          config.model,
        );

        this.logger.debug({ provider: config.provider, model: config.model });

        const result = await provider.generateText({
          prompt: input.userMessage,
          systemPrompt: input.systemPrompt,
          history: input.history,
          model,
          apiKey,
          baseUrl: config.baseUrl ?? '',
          maxTokens: input.maxTokens ?? 400,
          temperature: input.temperature ?? 0.7,
          tools: input.tools,
          toolExecutor: input.toolExecutor,
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
    const attempted = new Set<string>();

    let currentModel: AiModelConfig | null = initialModel;
    let lastError: ClassifiedAiError | null = null;

    while (currentModel) {
      if (attempted.has(currentModel.id)) {
        break;
      }

      attempted.add(currentModel.id);

      try {
        const { result, config } = await execute(currentModel);

        await this.selector.recordUsage(config.id, result.tokensUsed);

        this.logger.log(
          `IA: ${config.provider}/${config.model} | ` +
            `tokens: ${result.tokensUsed} | ` +
            `${result.latencyMs}ms` +
            (result.toolCallsExecuted?.length
              ? ` | tools: ${result.toolCallsExecuted
                  .map((t) => t.name)
                  .join(', ')}`
              : ''),
        );

        return {
          content: result.content,
          tokensUsed: result.tokensUsed,
          modelUsed: result.model,
          providerUsed: result.provider,
          latencyMs: result.latencyMs,
          modelConfigId: config.id,
          toolCallsExecuted: result.toolCallsExecuted,
        };
      } catch (error: unknown) {
        const classified = this.errorClassifier.classify(error);

        lastError = classified;

        this.logger.error(
          `Fallo ${currentModel.provider}/${currentModel.model} | ` +
            `tipo=${classified.type} | ` +
            `acción=${classified.action} | ` +
            `status=${classified.statusCode ?? 'N/A'} | ` +
            `${classified.message}`,
        );

        switch (classified.action) {
          case AiErrorAction.DISABLE_TEMPORARILY: {
            await this.selector.markRateLimited(
              currentModel.id,
              classified.retryAfterMs ?? 60_000,
            );

            break;
          }

          case AiErrorAction.DISABLE: {
            await this.selector.markDisabled(currentModel.id);

            break;
          }

          case AiErrorAction.ABORT: {
            throw classified.originalError;
          }

          case AiErrorAction.RETRY:
          case AiErrorAction.FALLBACK:
          default:
            break;
        }

        if (
          classified.action !== AiErrorAction.FALLBACK &&
          classified.action !== AiErrorAction.DISABLE_TEMPORARILY
        ) {
          throw classified.originalError;
        }

        const next = await this.selector.selectModel(botConfigId, role);

        if (!next || attempted.has(next.id)) {
          break;
        }

        this.logger.warn(
          `Fallback: ` +
            `${currentModel.provider}/${currentModel.model} → ` +
            `${next.provider}/${next.model} ` +
            `(${classified.type})`,
        );

        currentModel = next;
      }
    }

    throw new Error(
      `Todos los modelos disponibles fallaron. ` +
        `Último error: ${lastError?.message ?? 'desconocido'}`,
    );
  }
}
