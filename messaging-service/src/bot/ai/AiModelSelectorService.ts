import { Injectable, Logger } from '@nestjs/common';
import { AiProviderType } from './interface/AiProviderType';
import { PrismaService } from 'src/shared/prisma.service';
import { AiModelConfig, AiModelRole, AiModelTier } from '@prisma/client';

@Injectable()
export class AiModelSelectorService {
  private readonly logger = new Logger(AiModelSelectorService.name);

  constructor(private readonly prisma: PrismaService) {}

  async selectModel(
    botConfigId: string,
    role: AiModelRole,
  ): Promise<AiModelConfig | null> {
    const candidates = await this.prisma.aiModelConfig.findMany({
      where: { botConfigId, role, isActive: true },

      orderBy: { priority: 'asc' },
    });

    if (candidates.length === 0) {
      if (role === AiModelRole.IMAGE_ANALYSIS) {
        return this.selectModel(botConfigId, AiModelRole.CONVERSATION);
      }
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

  private async isAvailable(model: AiModelConfig): Promise<boolean> {
    if (model.tier === AiModelTier.PAID) return true;

    const now = new Date();

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

  async markUnavailable(modelId: string): Promise<void> {
    await this.prisma.aiModelConfig.update({
      where: { id: modelId },
      data: { requestsThisMinute: 999999, lastMinuteResetAt: new Date() },
    });
  }
}
