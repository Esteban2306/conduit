import { Injectable, Logger } from '@nestjs/common';
import { AiModelConfig, AiModelRole, AiModelTier } from '@prisma/client';
import { PrismaService } from 'src/shared/prisma.service';

@Injectable()
export class AiModelSelectorService {
  private readonly logger = new Logger(AiModelSelectorService.name);

  constructor(private readonly prisma: PrismaService) {}

  async selectModel(
    botConfigId: string,
    role: AiModelRole,
  ): Promise<AiModelConfig | null> {
    const candidates = await this.prisma.aiModelConfig.findMany({
      where: {
        botConfigId,
        role,
        isActive: true,
      },
      orderBy: { priority: 'asc' },
    });

    if (candidates.length === 0) {
      if (role === AiModelRole.IMAGE_ANALYSIS) {
        return this.selectModel(botConfigId, AiModelRole.CONVERSATION);
      }
      return null;
    }

    for (const candidate of candidates) {
      const available = await this.isAvailable(candidate);
      if (available) {
        return candidate;
      }
      this.logger.warn(
        `Modelo ${candidate.provider}/${candidate.model} no disponible. Probando siguiente...`,
      );
    }

    if (role !== AiModelRole.FALLBACK) {
      const fallback = await this.selectModel(
        botConfigId,
        AiModelRole.FALLBACK,
      );
      if (fallback) {
        this.logger.warn(
          `Usando modelo FALLBACK: ${fallback.provider}/${fallback.model}`,
        );
        return fallback;
      }
    }

    this.logger.error(
      `Sin modelos disponibles para botConfig ${botConfigId} rol ${role}`,
    );
    return null;
  }

  private async isAvailable(model: AiModelConfig): Promise<boolean> {
    if (model.tier === AiModelTier.PAID) return true;

    const now = new Date();

    const lastReset = new Date(model.lastResetAt);
    const daysSinceReset =
      (now.getTime() - lastReset.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceReset >= 1) {
      await this.prisma.aiModelConfig.update({
        where: { id: model.id },
        data: {
          tokensUsedToday: 0,
          lastResetAt: now,
        },
      });
      model.tokensUsedToday = 0;
    }

    if (
      model.dailyTokenLimit &&
      model.tokensUsedToday >= model.dailyTokenLimit
    ) {
      this.logger.warn(
        `${model.provider}/${model.model}: límite diario alcanzado (${model.tokensUsedToday}/${model.dailyTokenLimit} tokens)`,
      );
      return false;
    }

    if (
      model.minuteRequestLimit &&
      model.requestsThisMinute >= model.minuteRequestLimit
    ) {
      this.logger.warn(
        `${model.provider}/${model.model}: límite por minuto alcanzado (${model.requestsThisMinute}/${model.minuteRequestLimit} requests)`,
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
    this.logger.warn(
      `Marcando modelo ${modelId} como no disponible temporalmente`,
    );
    await this.prisma.aiModelConfig.update({
      where: { id: modelId },
      data: {
        requestsThisMinute: 999999,
      },
    });
  }
}
