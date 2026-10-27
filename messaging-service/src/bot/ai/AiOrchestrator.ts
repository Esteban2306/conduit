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
import { GenerateTextResult } from './interface/AiProvider';
import {
  AnalyzeImageInput,
  GenerateResponseInput,
  OrchestratorResult,
} from './interface/AiOrchestator.types';
import { AiProviderType } from './interface/AiProviderType';
import { resolveModel } from '../helper/model-resolver';
import { AiErrorClassifier } from './AiErrorClassifier';
import {
  AiErrorAction,
  AiErrorType,
  ClassifiedAiError,
} from './interface/AiError';
import { maskSecrets } from 'src/shared/security/mask-secrets';
import { BotEscalationService } from '../tools/BotEscalation.service';
import {
  AI_CALL_TIMEOUT_MS,
  BudgetExceededError,
  TurnBudget,
} from './turn-budget';

const CLASSIFY_BUDGET_MS = 10_000;
const MIN_RETRY_MS = 8_000;

@Injectable()
export class AiOrchestrator {
  private readonly logger = new Logger(AiOrchestrator.name);

  constructor(
    private readonly selector: AiModelSelectorService,
    private readonly providerFactory: AiProviderFactory,
    private readonly errorClassifier: AiErrorClassifier,
    private readonly escalation: BotEscalationService,
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
      input.budget ?? new TurnBudget(),
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
          systemBlocks: input.systemBlocks,
          reasoningMode: input.reasoningMode,
          history: input.history,
          model,
          apiKey,
          baseUrl: config.baseUrl ?? '',
          maxTokens: input.maxTokens ?? 800,
          temperature: input.temperature ?? 0.7,
          tools: input.tools,
          toolExecutor: input.toolExecutor,
        });

        return { result, config };
      },
    );
  }

  /**
   * Clasificación mínima: una llamada sin herramientas ni razonamiento y con
   * muy pocos tokens de salida. Usa el modelo de rol CLASSIFIER del bot y, si
   * no tiene, el de conversación.
   */
  async classify(input: {
    botConfigId: string;
    systemPrompt: string;
    userMessage: string;
    maxTokens?: number;
  }): Promise<OrchestratorResult> {
    const modelConfig =
      (await this.selector.selectModel(
        input.botConfigId,
        AiModelRole.CLASSIFIER,
      )) ??
      (await this.selector.selectModel(
        input.botConfigId,
        AiModelRole.CONVERSATION,
      ));
    if (!modelConfig) {
      throw new BadRequestException('Sin modelos de IA disponibles');
    }

    return this.executeWithFallback(
      modelConfig,
      input.botConfigId,
      modelConfig.role,
      new TurnBudget(CLASSIFY_BUDGET_MS),
      async (config) => {
        const provider = this.providerFactory.getProvider(
          config.provider as AiProviderType,
        );
        const result = await provider.generateText({
          prompt: input.userMessage,
          systemPrompt: input.systemPrompt,
          reasoningMode: 'OFF',
          history: [],
          model: resolveModel(config.provider as AiProviderType, config.model),
          apiKey: await this.selector.resolveApiKey(config),
          baseUrl: config.baseUrl ?? '',
          maxTokens: input.maxTokens ?? 12,
          temperature: 0,
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
      new TurnBudget(),
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

  /**
   * Prueba barata de una credencial (1 token, sin herramientas ni razonamiento).
   * Si falla, deja registrado el estado correspondiente (credencial inválida o
   * circuito) y devuelve el error clasificado.
   */
  async probe(
    config: AiModelConfig,
  ): Promise<{ ok: true } | { ok: false; error: ClassifiedAiError }> {
    try {
      const provider = this.providerFactory.getProvider(
        config.provider as AiProviderType,
      );
      await new TurnBudget(AI_CALL_TIMEOUT_MS).race(
        provider.generateText({
          prompt: 'ping',
          systemPrompt: 'Responde con una palabra.',
          reasoningMode: 'OFF',
          history: [],
          model: resolveModel(config.provider as AiProviderType, config.model),
          apiKey: await this.selector.resolveApiKey(config),
          baseUrl: config.baseUrl ?? '',
          maxTokens: 1,
          temperature: 0,
        }),
      );
      return { ok: true };
    } catch (error: unknown) {
      const classified = this.errorClassifier.classify(error);
      await this.registerFailure(config, config.botConfigId, classified);
      return { ok: false, error: classified };
    }
  }

  private async executeWithFallback(
    initialModel: AiModelConfig,
    botConfigId: string,
    role: AiModelRole,
    budget: TurnBudget,
    execute: (
      config: AiModelConfig,
    ) => Promise<{ result: GenerateTextResult; config: AiModelConfig }>,
  ): Promise<OrchestratorResult> {
    const attempted = new Set<string>();

    let currentModel: AiModelConfig | null = initialModel;
    let lastError: ClassifiedAiError | null = null;

    while (currentModel) {
      if (attempted.has(currentModel.id)) break;
      attempted.add(currentModel.id);

      let retried = false;
      let prefetched: AiModelConfig | null = null;
      for (;;) {
        try {
          if (budget.expired()) throw new BudgetExceededError();
          const { result, config } = await budget.race(execute(currentModel));

          await this.selector.recordUsage(config.id, result.tokensUsed);
          await this.selector.recordSuccess(currentModel);

          this.logger.log(
            `IA: ${config.provider}/${config.model} | ` +
              `tokens: ${result.tokensUsed}` +
              (result.usage
                ? ` (in ${result.usage.input}, caché ${result.usage.cacheRead}/${result.usage.cacheWrite}, out ${result.usage.output}, razonamiento ${result.usage.thinking})`
                : '') +
              ` | ` +
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
            usage: result.usage,
            stopReason: result.stopReason,
            modelUsed: result.model,
            providerUsed: result.provider,
            latencyMs: result.latencyMs,
            llmCalls: result.llmCalls,
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
              `${maskSecrets(classified.message)}`,
          );

          if (classified.action === AiErrorAction.ABORT) {
            throw classified.originalError;
          }

          const transient =
            classified.type === AiErrorType.SERVER_ERROR ||
            classified.type === AiErrorType.NETWORK_ERROR;
          if (transient && !retried && budget.remaining() >= MIN_RETRY_MS) {
            retried = true;
            continue;
          }

          if (
            classified.type === AiErrorType.TIMEOUT &&
            !retried &&
            budget.remaining() >= MIN_RETRY_MS
          ) {
            prefetched = await this.selector.selectModel(
              botConfigId,
              role,
              attempted,
            );
            if (!prefetched) {
              retried = true;
              continue;
            }
          }

          await this.registerFailure(currentModel, botConfigId, classified);
          break;
        }
      }

      if (budget.expired()) break;

      const next =
        prefetched ??
        (await this.selector.selectModel(botConfigId, role, attempted));
      if (!next || attempted.has(next.id)) break;

      this.logger.warn(
        `Fallback: ` +
          `${currentModel.provider}/${currentModel.model} → ` +
          `${next.provider}/${next.model} ` +
          `(${lastError?.type})`,
      );
      currentModel = next;
    }

    throw new Error(
      `Todos los modelos disponibles fallaron. ` +
        `Último error: ${maskSecrets(lastError?.message ?? 'desconocido')}`,
    );
  }

  private async registerFailure(
    model: AiModelConfig,
    botConfigId: string,
    classified: ClassifiedAiError,
  ): Promise<void> {
    try {
      if (classified.action === AiErrorAction.DISABLE) {
        const first = await this.selector.markCredentialInvalid(
          model.id,
          classified.type,
        );
        if (first) {
          await this.escalation.notifyAiCredentialInvalid(
            botConfigId,
            `${model.provider}/${model.model}`,
            maskSecrets(classified.message),
          );
        }
        return;
      }
      const state = await this.selector.recordFailure(
        model.id,
        classified.type,
        classified.retryAfterMs,
      );
      if (state.openUntil) {
        this.logger.warn(
          `${model.provider}/${model.model}: circuito abierto hasta ${state.openUntil.toISOString()} tras ${state.failures} fallo(s)`,
        );
      }
    } catch (error: unknown) {
      this.logger.error(
        `No se pudo registrar el fallo de ${model.provider}/${model.model}: ${maskSecrets(error instanceof Error ? error.message : String(error))}`,
      );
    }
  }
}
