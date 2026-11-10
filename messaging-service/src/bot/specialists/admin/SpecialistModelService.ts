import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/shared/prisma.service';
import { SecretEncryptionService } from 'src/shared/security/secret-encryption.service';
import { maskSecrets } from 'src/shared/security/mask-secrets';
import { AI_MODEL_PUBLIC_SELECT } from 'src/bot/dto/ai-model-public';
import { AiOrchestrator } from 'src/bot/ai/AiOrchestrator';
import { parseOrThrow } from './specialist-admin.schemas';
import {
  createSpecialistModelSchema,
  updateSpecialistModelSchema,
} from './specialist-model.schemas';

const USABLE_ROLES = ['IMAGE_ANALYSIS', 'FALLBACK'] as const;

const CLEAN_STATE = {
  consecutiveFailures: 0,
  unavailableUntil: null,
  lastErrorType: null,
  lastErrorAt: null,
  credentialInvalidAt: null,
} as const;

type Tx = Prisma.TransactionClient;

@Injectable()
export class SpecialistModelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: SecretEncryptionService,
    private readonly orchestrator: AiOrchestrator,
  ) {}

  async list(tenantId: string, specialistId: string) {
    await this.loadSpecialist(tenantId, specialistId);
    return this.prisma.aiModelConfig.findMany({
      where: { specialistId },
      select: AI_MODEL_PUBLIC_SELECT,
      orderBy: [{ role: 'asc' }, { priority: 'asc' }],
    });
  }

  async create(tenantId: string, specialistId: string, body: unknown) {
    const input = parseOrThrow(createSpecialistModelSchema, body);
    await this.loadWritable(tenantId, specialistId);

    return this.prisma.aiModelConfig.create({
      data: {
        specialistId,
        provider: input.provider,
        model: input.model,
        apiKey: this.encryption.seal(input.apiKey),
        apiKeyLast4: this.encryption.last4(input.apiKey),
        baseUrl: input.baseUrl,
        role: input.role,
        tier: input.tier,
        priority: input.priority,
        dailyTokenLimit: input.dailyTokenLimit,
        minuteRequestLimit: input.minuteRequestLimit,
      },
      select: AI_MODEL_PUBLIC_SELECT,
    });
  }

  async update(
    tenantId: string,
    specialistId: string,
    modelId: string,
    body: unknown,
  ) {
    const input = parseOrThrow(updateSpecialistModelSchema, body);
    await this.loadWritable(tenantId, specialistId);
    await this.loadModel(specialistId, modelId);

    const { apiKey, ...rest } = input;
    const data: Prisma.AiModelConfigUncheckedUpdateInput = {
      ...rest,
      ...(apiKey
        ? {
            apiKey: this.encryption.seal(apiKey),
            apiKeyLast4: this.encryption.last4(apiKey),
            ...CLEAN_STATE,
          }
        : {}),
    };

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.aiModelConfig.update({
        where: { id: modelId },
        data,
        select: AI_MODEL_PUBLIC_SELECT,
      });
      await this.assertServiceable(tx, tenantId, specialistId);
      return updated;
    });
  }

  async remove(tenantId: string, specialistId: string, modelId: string) {
    await this.loadWritable(tenantId, specialistId);
    await this.loadModel(specialistId, modelId);

    return this.prisma.$transaction(async (tx) => {
      const removed = await tx.aiModelConfig.delete({
        where: { id: modelId },
        select: AI_MODEL_PUBLIC_SELECT,
      });
      await this.assertServiceable(tx, tenantId, specialistId);
      return removed;
    });
  }

  async reactivate(tenantId: string, specialistId: string, modelId: string) {
    await this.loadWritable(tenantId, specialistId);
    await this.loadModel(specialistId, modelId);

    await this.prisma.aiModelConfig.update({
      where: { id: modelId },
      data: {
        ...CLEAN_STATE,
        tokensUsedToday: 0,
        requestsThisMinute: 0,
        lastResetAt: new Date(),
        lastMinuteResetAt: new Date(),
      },
      select: { id: true },
    });

    const full = await this.prisma.aiModelConfig.findUniqueOrThrow({
      where: { id: modelId },
    });
    const probe = await this.orchestrator.probe(full);
    const model = await this.prisma.aiModelConfig.findUniqueOrThrow({
      where: { id: modelId },
      select: AI_MODEL_PUBLIC_SELECT,
    });

    return {
      ...model,
      reactivation: probe.ok
        ? { ok: true }
        : {
            ok: false,
            errorType: probe.error.type,
            message: maskSecrets(probe.error.message),
          },
    };
  }

  private async assertServiceable(
    tx: Tx,
    tenantId: string,
    specialistId: string,
  ): Promise<void> {
    const usable = await tx.aiModelConfig.count({
      where: {
        specialistId,
        isActive: true,
        credentialInvalidAt: null,
        role: { in: [...USABLE_ROLES] },
      },
    });
    if (usable > 0) return;

    const live = await tx.botSpecialistBinding.findMany({
      where: { tenantId, specialistId, mode: { not: 'OFF' } },
      select: { botConfigId: true, mode: true },
    });
    if (live.length > 0) {
      throw new ConflictException({
        message:
          'Este cambio dejaría al especialista sin ningún modelo utilizable mientras tiene vínculos en uso. Apaga esos vínculos o añade otro modelo antes.',
        details: { bindings: live },
      });
    }
  }

  private async loadSpecialist(tenantId: string, id: string) {
    const found = await this.prisma.specialist.findFirst({
      where: { id, tenantId },
      select: { id: true, archivedAt: true },
    });
    if (!found) throw new NotFoundException('Especialista no encontrado.');
    return found;
  }

  private async loadWritable(tenantId: string, id: string) {
    const found = await this.loadSpecialist(tenantId, id);
    if (found.archivedAt) {
      throw new ConflictException(
        'El especialista está archivado: desarchívalo para modificarlo.',
      );
    }
    return found;
  }

  private async loadModel(specialistId: string, modelId: string) {
    const found = await this.prisma.aiModelConfig.findFirst({
      where: { id: modelId, specialistId },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('Modelo no encontrado.');
    return found;
  }
}
