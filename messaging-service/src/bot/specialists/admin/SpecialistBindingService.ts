import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/shared/prisma.service';
import { BotConfigService } from 'src/bot/config/BotConfigService';
import { capabilitySchema, rulesDocumentSchema } from '../contracts';
import { parseOrThrow } from './specialist-admin.schemas';
import { upsertBindingSchema } from './specialist-binding.schemas';

export const MIN_SHADOW_SAMPLE = 20;
export const MIN_SHADOW_AGREEMENT = 0.8;
const MIN_COMPARED_FOR_AGREEMENT = 5;
const SAMPLE_WINDOW_MS = 30 * 86_400_000;
const USABLE_ROLES = ['IMAGE_ANALYSIS', 'FALLBACK'] as const;

const BINDING_SELECT = {
  id: true,
  botConfigId: true,
  capability: true,
  specialistId: true,
  mode: true,
  timeoutMs: true,
  onFailure: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BotSpecialistBindingSelect;

export interface BindingBlocker {
  code: 'SPECIALIST_NOT_ACTIVE' | 'NO_USABLE_MODEL' | 'NO_RULES';
  message: string;
}

export interface BindingWarning {
  code: 'LOW_SHADOW_SAMPLE' | 'LOW_SHADOW_AGREEMENT';
  message: string;
  count?: number;
  required?: number;
  rate?: number;
}

@Injectable()
export class SpecialistBindingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bots: BotConfigService,
  ) {}

  async list(tenantId: string, botId: string) {
    await this.bots.findOne(botId, tenantId);
    return this.prisma.botSpecialistBinding.findMany({
      where: { tenantId, botConfigId: botId },
      select: {
        ...BINDING_SELECT,
        specialist: {
          select: {
            id: true,
            key: true,
            name: true,
            status: true,
            version: true,
            archivedAt: true,
          },
        },
      },
      orderBy: { capability: 'asc' },
    });
  }

  async upsert(
    tenantId: string,
    botId: string,
    capabilityParam: string,
    body: unknown,
  ) {
    const capability = parseOrThrow(capabilitySchema, capabilityParam);
    const input = parseOrThrow(upsertBindingSchema, body);
    await this.bots.findOne(botId, tenantId);

    const specialist = await this.prisma.specialist.findFirst({
      where: { id: input.specialistId, tenantId },
      select: {
        id: true,
        status: true,
        archivedAt: true,
        capability: true,
        rules: true,
        version: true,
      },
    });
    if (!specialist) throw new NotFoundException('Especialista no encontrado.');
    if (specialist.capability !== capability) {
      throw new BadRequestException({
        message:
          'La capacidad del vínculo debe ser la misma que la del especialista.',
        details: {
          binding: capability,
          specialist: specialist.capability,
        },
      });
    }
    if (specialist.archivedAt) {
      throw new ConflictException(
        'El especialista está archivado: desarchívalo antes de vincularlo.',
      );
    }

    let warnings: BindingWarning[] = [];
    if (input.mode !== 'OFF') {
      const blockers = await this.blockers(specialist, input.mode);
      if (blockers.length > 0) {
        throw new ConflictException({
          message: `No se puede poner el vínculo en ${input.mode}.`,
          details: { blockers },
        });
      }
      if (input.mode === 'ACTIVE') {
        warnings = await this.shadowWarnings(
          tenantId,
          botId,
          specialist.id,
          capability,
        );
      }
    }

    const data = {
      specialistId: specialist.id,
      mode: input.mode,
      timeoutMs: input.timeoutMs,
      onFailure: input.onFailure,
    };
    const binding = await this.prisma.botSpecialistBinding.upsert({
      where: { botConfigId_capability: { botConfigId: botId, capability } },
      create: { ...data, tenantId, botConfigId: botId, capability },
      update: data,
      select: BINDING_SELECT,
    });

    return { binding, warnings };
  }

  async remove(tenantId: string, botId: string, capabilityParam: string) {
    const capability = parseOrThrow(capabilitySchema, capabilityParam);
    await this.bots.findOne(botId, tenantId);

    const binding = await this.prisma.botSpecialistBinding.findFirst({
      where: { tenantId, botConfigId: botId, capability },
      select: { id: true, mode: true },
    });
    if (!binding) throw new NotFoundException('Vínculo no encontrado.');
    if (binding.mode !== 'OFF') {
      throw new ConflictException(
        'Apaga el vínculo (modo OFF) antes de eliminarlo.',
      );
    }

    return this.prisma.botSpecialistBinding.delete({
      where: { id: binding.id },
      select: BINDING_SELECT,
    });
  }

  private async blockers(
    specialist: { id: string; status: string; rules: unknown },
    mode: 'SHADOW' | 'ACTIVE',
  ): Promise<BindingBlocker[]> {
    const blockers: BindingBlocker[] = [];

    if (specialist.status !== 'ACTIVE') {
      blockers.push({
        code: 'SPECIALIST_NOT_ACTIVE',
        message: 'El especialista está inactivo: actívalo primero.',
      });
    }

    const usable = await this.prisma.aiModelConfig.count({
      where: {
        specialistId: specialist.id,
        isActive: true,
        credentialInvalidAt: null,
        role: { in: [...USABLE_ROLES] },
      },
    });
    if (usable === 0) {
      blockers.push({
        code: 'NO_USABLE_MODEL',
        message:
          'El especialista no tiene ningún modelo activo con credencial válida.',
      });
    }

    if (mode === 'ACTIVE') {
      const rules = rulesDocumentSchema.safeParse(specialist.rules);
      if (!rules.success || rules.data.rules.length === 0) {
        blockers.push({
          code: 'NO_RULES',
          message:
            'Sin reglas, toda imagen legible resultaría válida. Define al menos una regla antes de pasar a ACTIVE.',
        });
      }
    }
    return blockers;
  }

  private async shadowWarnings(
    tenantId: string,
    botConfigId: string,
    specialistId: string,
    capability: string,
  ): Promise<BindingWarning[]> {
    const base: Prisma.VerificationRecordWhereInput = {
      tenantId,
      botConfigId,
      specialistId,
      capability,
      mode: 'SHADOW',
      verdict: { not: 'ERROR' },
      createdAt: { gte: new Date(Date.now() - SAMPLE_WINDOW_MS) },
    };
    const [total, compared, agreed] = await Promise.all([
      this.prisma.verificationRecord.count({ where: base }),
      this.prisma.verificationRecord.count({
        where: { ...base, comparison: { not: Prisma.DbNull } },
      }),
      this.prisma.verificationRecord.count({
        where: { ...base, comparison: { path: ['agrees'], equals: true } },
      }),
    ]);

    const warnings: BindingWarning[] = [];
    if (total < MIN_SHADOW_SAMPLE) {
      warnings.push({
        code: 'LOW_SHADOW_SAMPLE',
        message: `Solo hay ${total} verificaciones en SHADOW de los últimos 30 días para este especialista; se recomiendan al menos ${MIN_SHADOW_SAMPLE} antes de pasar a ACTIVE.`,
        count: total,
        required: MIN_SHADOW_SAMPLE,
      });
    }
    if (compared >= MIN_COMPARED_FOR_AGREEMENT) {
      const rate = agreed / compared;
      if (rate < MIN_SHADOW_AGREEMENT) {
        warnings.push({
          code: 'LOW_SHADOW_AGREEMENT',
          message: `El especialista coincide con el análisis actual solo en el ${Math.round(rate * 100)} % de los casos comparados.`,
          rate: Math.round(rate * 100) / 100,
        });
      }
    }
    return warnings;
  }
}
