import { AiModelRole, PrismaClient } from '@prisma/client';
import { maskSecrets } from 'src/shared/security/mask-secrets';
import { resolveUniqueKey, slugifyKey } from 'src/shared/stable-key';
import { IMAGE_ANALYSIS_CAPABILITY } from '../constants';
import { DEFAULT_TIMEOUT_MS } from '../contracts';

export const DEFAULT_IMAGE_PROMPT =
  'Imágenes que envían los clientes por WhatsApp, por ejemplo comprobantes de pago o fotos de documentos. Lee los datos visibles tal como aparecen.';

export interface BackfillOptions {
  apply: boolean;
  tenantId?: string;
}

export type BackfillSkipReason = 'ALREADY_BOUND' | 'NO_USABLE_MODEL' | 'ERROR';

export interface BackfillEntry {
  botConfigId: string;
  tenantId: string;
  specialistId?: string;
  specialistKey?: string;
  models: number;
}

export interface BackfillReport {
  apply: boolean;
  examined: number;
  created: BackfillEntry[];
  skipped: Array<{
    botConfigId: string;
    reason: BackfillSkipReason;
    detail?: string;
  }>;
}

const COPIED_ROLES = [AiModelRole.IMAGE_ANALYSIS, AiModelRole.FALLBACK];

export async function backfillSpecialists(
  prisma: PrismaClient,
  options: BackfillOptions,
): Promise<BackfillReport> {
  const bots = await prisma.botConfig.findMany({
    where: {
      ...(options.tenantId ? { tenantId: options.tenantId } : {}),
      aiModels: {
        some: { isActive: true, role: AiModelRole.IMAGE_ANALYSIS },
      },
    },
    select: { id: true, tenantId: true, key: true, name: true },
    orderBy: { createdAt: 'asc' },
  });

  const report: BackfillReport = {
    apply: options.apply,
    examined: bots.length,
    created: [],
    skipped: [],
  };

  for (const bot of bots) {
    try {
      const bound = await prisma.botSpecialistBinding.findFirst({
        where: { botConfigId: bot.id, capability: IMAGE_ANALYSIS_CAPABILITY },
        select: { id: true },
      });
      if (bound) {
        report.skipped.push({ botConfigId: bot.id, reason: 'ALREADY_BOUND' });
        continue;
      }

      const models = await prisma.aiModelConfig.findMany({
        where: {
          botConfigId: bot.id,
          isActive: true,
          credentialInvalidAt: null,
          role: { in: COPIED_ROLES },
        },
        orderBy: [{ role: 'asc' }, { priority: 'asc' }],
        select: {
          provider: true,
          model: true,
          apiKey: true,
          apiKeyLast4: true,
          baseUrl: true,
          role: true,
          tier: true,
          priority: true,
          dailyTokenLimit: true,
          minuteRequestLimit: true,
        },
      });
      if (!models.some((m) => m.role === AiModelRole.IMAGE_ANALYSIS)) {
        report.skipped.push({
          botConfigId: bot.id,
          reason: 'NO_USABLE_MODEL',
        });
        continue;
      }

      if (!options.apply) {
        report.created.push({
          botConfigId: bot.id,
          tenantId: bot.tenantId,
          models: models.length,
        });
        continue;
      }

      const entry = await prisma.$transaction(async (tx) => {
        const base = `${slugifyKey(bot.key ?? bot.name, 'bot')
          .slice(0, 45)
          .replace(/-+$/, '')}-imagen`;
        const key = await resolveUniqueKey(
          base,
          async (candidate) =>
            (await tx.specialist.count({
              where: { tenantId: bot.tenantId, key: candidate },
            })) > 0,
        );
        const specialist = await tx.specialist.create({
          data: {
            tenantId: bot.tenantId,
            key,
            name: `${bot.name} · análisis de imagen`.slice(0, 120),
            capability: IMAGE_ANALYSIS_CAPABILITY,
            status: 'ACTIVE',
            promptTemplate: DEFAULT_IMAGE_PROMPT,
          },
        });
        await tx.aiModelConfig.createMany({
          data: models.map((m) => ({
            specialistId: specialist.id,
            provider: m.provider,
            model: m.model,
            apiKey: m.apiKey,
            apiKeyLast4: m.apiKeyLast4,
            baseUrl: m.baseUrl,
            role: m.role,
            tier: m.tier,
            priority: m.priority,
            isActive: true,
            dailyTokenLimit: m.dailyTokenLimit,
            minuteRequestLimit: m.minuteRequestLimit,
          })),
        });
        await tx.botSpecialistBinding.create({
          data: {
            tenantId: bot.tenantId,
            botConfigId: bot.id,
            capability: IMAGE_ANALYSIS_CAPABILITY,
            specialistId: specialist.id,
            mode: 'SHADOW',
            timeoutMs: DEFAULT_TIMEOUT_MS,
          },
        });
        return { specialistId: specialist.id, specialistKey: key };
      });

      report.created.push({
        botConfigId: bot.id,
        tenantId: bot.tenantId,
        models: models.length,
        ...entry,
      });
    } catch (error) {
      report.skipped.push({
        botConfigId: bot.id,
        reason: 'ERROR',
        detail: maskSecrets(
          error instanceof Error ? error.message : String(error),
        ).slice(0, 300),
      });
    }
  }

  return report;
}
