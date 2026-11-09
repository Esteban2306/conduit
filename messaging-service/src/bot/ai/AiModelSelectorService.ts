import { Injectable, Logger } from '@nestjs/common';
import { AiProviderType } from './interface/AiProviderType';
import { PrismaService } from 'src/shared/prisma.service';
import { AiModelConfig, AiModelRole, AiModelTier } from '@prisma/client';
import { AiErrorType } from './interface/AiError';
import { ConfigService } from '@nestjs/config';
import { SecretEncryptionService } from 'src/shared/security/secret-encryption.service';

export const CIRCUIT_OPEN_AFTER_FAILURES = 2;
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];
const MAX_RETRY_AFTER_MS = 600_000;
const PROBE_WINDOW_MS = 30_000;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export type AiModelOwner = string | { specialistId: string };

export function ownerFilter(
  owner: AiModelOwner,
): { botConfigId: string } | { specialistId: string } {
  return typeof owner === 'string' ? { botConfigId: owner } : owner;
}

export function ownerOf(model: AiModelConfig): AiModelOwner {
  if (model.botConfigId) return model.botConfigId;
  if (model.specialistId) return { specialistId: model.specialistId };
  throw new Error(`El modelo ${model.id} no tiene dueño`);
}

@Injectable()
export class AiModelSelectorService {
  private readonly logger = new Logger(AiModelSelectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryption: SecretEncryptionService,
  ) {}

  async selectModel(
    owner: AiModelOwner,
    role: AiModelRole,
    exclude: ReadonlySet<string> = new Set(),
  ): Promise<AiModelConfig | null> {
    const candidates = await this.prisma.aiModelConfig.findMany({
      where: {
        ...ownerFilter(owner),
        role,
        isActive: true,
        credentialInvalidAt: null,
      },

      orderBy: { priority: 'asc' },
    });

    for (const candidate of candidates) {
      if (exclude.has(candidate.id)) continue;
      if (await this.isAvailable(candidate)) return candidate;
      this.logger.warn(
        `${candidate.provider}/${candidate.model} no disponible`,
      );
    }

    if (role !== AiModelRole.FALLBACK) {
      return this.selectModel(owner, AiModelRole.FALLBACK, exclude);
    }

    return null;
  }

  async resolveApiKey(model: AiModelConfig): Promise<string> {
    const stored = this.openStoredKey(model);
    const isPlaceholder =
      !stored ||
      stored.length < 20 ||
      stored.toUpperCase().includes('_KEY') ||
      stored.toUpperCase().includes('YOUR_') ||
      stored === 'placeholder';

    if (!isPlaceholder) {
      return stored;
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
          `La key guardada para este modelo parece un placeholder. ` +
          `Configura una key real o añade ${envKey} al .env`,
      );
    }

    return systemKey;
  }

  private openStoredKey(model: AiModelConfig): string {
    try {
      return this.encryption.open(model.apiKey ?? '');
    } catch {
      throw new Error(
        `No fue posible descifrar la API key del modelo ${model.id}: ` +
          `la clave maestra INTEGRATION_ENCRYPTION_KEY no corresponde a la usada al guardarla.`,
      );
    }
  }

  /**
   * Interruptor de circuito: con `unavailableUntil` en el futuro está abierto;
   * vencido, está semiabierto y una sola llamada (la que gane el reclamo)
   * prueba el modelo; sin fecha está cerrado. Aplica a todos los modelos; los
   * límites de tokens y de minuto solo a los gratuitos.
   */
  private async isAvailable(model: AiModelConfig): Promise<boolean> {
    const now = new Date();

    if (model.unavailableUntil) {
      if (model.unavailableUntil > now) {
        this.logger.warn(
          `${model.provider}/${model.model}: circuito abierto hasta ${model.unavailableUntil.toISOString()}`,
        );
        return false;
      }
      if (!(await this.claimProbe(model, now))) return false;
    }

    if (model.tier === AiModelTier.PAID) return true;

    await this.rollWindows(model, now);

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

  private async claimProbe(model: AiModelConfig, now: Date): Promise<boolean> {
    const claimed = await this.prisma.aiModelConfig.updateMany({
      where: { id: model.id, unavailableUntil: model.unavailableUntil },
      data: { unavailableUntil: new Date(now.getTime() + PROBE_WINDOW_MS) },
    });
    return claimed.count === 1;
  }

  private async rollWindows(model: AiModelConfig, now: Date): Promise<void> {
    const daily = await this.prisma.aiModelConfig.updateMany({
      where: {
        id: model.id,
        lastResetAt: { lte: new Date(now.getTime() - DAY_MS) },
      },
      data: { tokensUsedToday: 0, lastResetAt: now },
    });
    const minute = await this.prisma.aiModelConfig.updateMany({
      where: {
        id: model.id,
        lastMinuteResetAt: { lte: new Date(now.getTime() - MINUTE_MS) },
      },
      data: { requestsThisMinute: 0, lastMinuteResetAt: now },
    });
    const stale =
      now.getTime() - model.lastResetAt.getTime() >= DAY_MS ||
      now.getTime() - model.lastMinuteResetAt.getTime() >= MINUTE_MS;
    if (!stale) return;
    if (daily.count === 1) model.tokensUsedToday = 0;
    if (minute.count === 1) model.requestsThisMinute = 0;
    if (daily.count === 0 || minute.count === 0) {
      const fresh = await this.prisma.aiModelConfig.findUnique({
        where: { id: model.id },
        select: { tokensUsedToday: true, requestsThisMinute: true },
      });
      if (fresh) Object.assign(model, fresh);
    }
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

  async recordSuccess(model: AiModelConfig): Promise<void> {
    if (model.consecutiveFailures === 0 && !model.unavailableUntil) return;
    await this.prisma.aiModelConfig.update({
      where: { id: model.id },
      data: {
        consecutiveFailures: 0,
        unavailableUntil: null,
        lastErrorType: null,
      },
    });
  }

  /**
   * Cuenta un fallo transitorio. El 429 abre el circuito al primero (y respeta
   * `retry-after`); 5xx, timeout y red al segundo seguido. El enfriamiento
   * crece con cada fallo adicional.
   */
  async recordFailure(
    modelId: string,
    type: AiErrorType,
    retryAfterMs?: number,
  ): Promise<{ failures: number; openUntil: Date | null }> {
    const now = new Date();
    const { consecutiveFailures: failures } =
      await this.prisma.aiModelConfig.update({
        where: { id: modelId },
        data: {
          consecutiveFailures: { increment: 1 },
          lastErrorType: type,
          lastErrorAt: now,
        },
        select: { consecutiveFailures: true },
      });

    const threshold =
      type === AiErrorType.RATE_LIMIT ? 1 : CIRCUIT_OPEN_AFTER_FAILURES;
    if (failures < threshold) return { failures, openUntil: null };

    const step = Math.min(failures - threshold, BACKOFF_MS.length - 1);
    const cooldown = Math.max(
      Math.min(retryAfterMs ?? 0, MAX_RETRY_AFTER_MS),
      BACKOFF_MS[step],
    );
    const openUntil = new Date(now.getTime() + cooldown);
    await this.prisma.aiModelConfig.update({
      where: { id: modelId },
      data: { unavailableUntil: openUntil },
    });
    return { failures, openUntil };
  }

  async markCredentialInvalid(
    modelId: string,
    type: AiErrorType,
  ): Promise<boolean> {
    const marked = await this.prisma.aiModelConfig.updateMany({
      where: { id: modelId, credentialInvalidAt: null },
      data: {
        credentialInvalidAt: new Date(),
        lastErrorType: type,
        lastErrorAt: new Date(),
      },
    });
    return marked.count === 1;
  }
}
