import { Injectable, Logger } from '@nestjs/common';
import { AiProviderType } from './interface/AiProviderType';
import { PrismaService } from 'src/shared/prisma.service';
import { AiModelConfig, AiModelRole, AiModelTier } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AiModelSelectorService {
  private readonly logger = new Logger(AiModelSelectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async selectModel(
    botConfigId: string,
    role: AiModelRole,
  ): Promise<AiModelConfig | null> {
    const candidates = await this.prisma.aiModelConfig.findMany({
      where: { botConfigId, role, isActive: true },

      orderBy: { priority: 'asc' },
    });

    if (candidates.length === 0) {
      return null;
    }

    for (const candidate of candidates) {
      if (await this.isAvailable(candidate)) return candidate;
      this.logger.warn(
        `${candidate.provider}/${candidate.model} no disponible`,
      );
    }

    if (role !== AiModelRole.FALLBACK) {
      return this.selectModel(botConfigId, AiModelRole.FALLBACK);
    }

    return null;
  }

  async resolveApiKey(model: AiModelConfig): Promise<string> {
    const isPlaceholder =
      !model.apiKey ||
      model.apiKey.length < 20 ||
      model.apiKey.toUpperCase().includes('_KEY') ||
      model.apiKey.toUpperCase().includes('YOUR_') ||
      model.apiKey === 'placeholder';

    if (!isPlaceholder) {
      return model.apiKey;
    }

    const envKeyMap: Record<string, string> = {
      ANTHROPIC: 'ANTHROPIC_DEFAULT_API_KEY',
      OPENAI: 'OPENAI_DEFAULT_API_KEY',
      GEMINI: 'GEMINI_DEFAULT_API_KEY',
      GROQ: 'GROQ_DEFAULT_API_KEY',
      MISTRAL: 'MISTRAL_DEFAULT_API_KEY',
      DEEPSEEK: 'DEEPSEEK_DEFAULT_API_KEY',
    };

    const envKey = envKeyMap[model.provider];
    const systemKey = envKey ? process.env[envKey] : undefined;

    if (!systemKey) {
      throw new Error(
        `Sin API key válida para ${model.provider}. ` +
          `La key en DB parece un placeholder ("${model.apiKey}"). ` +
          `Configura una key real o añade ${envKey} al .env`,
      );
    }

    return systemKey;
  }

  private async isAvailable(model: AiModelConfig): Promise<boolean> {
    if (model.tier === AiModelTier.PAID) return true;

    const now = new Date();

    if (model.unavailableUntil && model.unavailableUntil > now) {
      return false;
    }

    if (now.getTime() - model.lastResetAt.getTime() >= 86400000) {
      await this.prisma.aiModelConfig.update({
        where: { id: model.id },
        data: { tokensUsedToday: 0, lastResetAt: now },
      });
      model.tokensUsedToday = 0;
    }

    if (now.getTime() - model.lastMinuteResetAt.getTime() >= 60000) {
      await this.prisma.aiModelConfig.update({
        where: { id: model.id },
        data: { requestsThisMinute: 0, lastMinuteResetAt: now },
      });
      model.requestsThisMinute = 0;
    }

    if (model.unavailableUntil && model.unavailableUntil <= now) {
      await this.prisma.aiModelConfig.update({
        where: { id: model.id },
        data: {
          unavailableUntil: null,
        },
      });

      model.unavailableUntil = null;
    }

    if (model.unavailableUntil && model.unavailableUntil > now) {
      this.logger.warn(
        `${model.provider}/${model.model}: en cooldown por rate limit hasta ${model.unavailableUntil.toISOString()}`,
      );
      return false;
    }

    if (
      model.dailyTokenLimit &&
      model.tokensUsedToday >= model.dailyTokenLimit
    ) {
      this.logger.warn(
        `${model.provider}/${model.model}: límite diario (${model.tokensUsedToday}/${model.dailyTokenLimit})`,
      );
      return false;
    }

    if (
      model.minuteRequestLimit &&
      model.requestsThisMinute >= model.minuteRequestLimit
    ) {
      this.logger.warn(
        `${model.provider}/${model.model}: límite por minuto (${model.requestsThisMinute}/${model.minuteRequestLimit})`,
      );
      return false;
    }

    return true;
  }

  async recordUsage(modelId: string, tokensUsed: number): Promise<void> {
    await this.prisma.aiModelConfig.update({
      where: { id: modelId },
      data: {
        tokensUsedToday: { increment: tokensUsed },
        requestsThisMinute: { increment: 1 },
      },
    });
  }

  async markRateLimited(modelId: string, retryAfterMs = 60_000): Promise<void> {
    const unavailableUntil = new Date(Date.now() + retryAfterMs);

    await this.prisma.aiModelConfig.update({
      where: { id: modelId },
      data: {
        unavailableUntil,
      },
    });
  }

  async markDisabled(modelId: string): Promise<void> {
    await this.prisma.aiModelConfig.update({
      where: { id: modelId },
      data: {
        isActive: false,
      },
    });
  }
}
