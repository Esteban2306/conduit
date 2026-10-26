import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntentHandlerKind, IntentMode, Prisma } from '@prisma/client';
import { PrismaService } from 'src/shared/prisma.service';
import { BotConfigService } from '../config/BotConfigService';
import { CompiledIntent, compileIntent } from './IntentResolver';
import { IntentInput, validateIntentInput } from './intent-validation';
import {
  IntentConfig,
  IntentModeValue,
  IntentRecord,
  RULE_KEY_PREFIX,
} from './intent-types';
import { IntentSchedule } from './schedule';

export interface BotIntentSet {
  all: IntentRecord[];
  compiled: CompiledIntent[];
  byKey: Map<string, IntentRecord>;
  agent: string;
  business: string;
  modeOf(key: string): IntentModeValue;
}

const CACHE_MS = 30_000;

type Row = Awaited<ReturnType<PrismaService['botIntent']['findMany']>>[number];

export function toRecord(row: Row): IntentRecord {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    handler: row.handler,
    mode: row.mode,
    priority: row.priority,
    patterns: row.patterns as string[],
    denyPatterns: row.denyPatterns as string[],
    maxTokens: row.maxTokens,
    respectsOpenFlow: row.respectsOpenFlow,
    allowsQuestion: row.allowsQuestion,
    negationOk: row.negationOk,
    fixedConfidence: row.fixedConfidence,
    aiClassifiable: row.aiClassifiable,
    config: row.config as IntentConfig,
    variants: row.variants as Record<string, string[]>,
    cooldownSeconds: row.cooldownSeconds,
    schedule: (row.schedule as IntentSchedule | null) ?? null,
    notes: row.notes,
    version: row.version,
  };
}

/**
 * Intenciones por bot guardadas como datos: Conduit no conoce el negocio, el
 * negocio (o su seed) define frases, manejador, herramienta, plantilla y
 * programación. Los datos se validan al guardar y se cachean 30 s.
 */
@Injectable()
export class IntentRepository {
  private readonly logger = new Logger(IntentRepository.name);
  private readonly cache = new Map<string, { at: number; set: BotIntentSet }>();
  private warnedUnavailable = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly botConfigService: BotConfigService,
    private readonly config: ConfigService,
  ) {}

  timeZone(): string {
    return this.config.get<string>('whatsapp.timeZone') ?? 'America/Bogota';
  }

  async forBot(botConfigId: string): Promise<BotIntentSet> {
    const cached = this.cache.get(botConfigId);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.set;

    const [rows, identity] = await Promise.all([
      this.loadRows(botConfigId),
      this.loadIdentity(botConfigId),
    ]);
    const all = rows.map(toRecord).sort((a, b) => a.priority - b.priority);
    const byKey = new Map(all.map((r) => [r.key, r]));
    const set: BotIntentSet = {
      all,
      compiled: all
        .filter((r) => r.mode !== 'OFF')
        .map((record) => {
          try {
            return compileIntent(record);
          } catch (error) {
            this.logger.error(
              `Intención ${record.key} con patrón inválido; se ignora: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
          }
        })
        .filter((c): c is CompiledIntent => c !== null),
      byKey,
      agent: identity.agent,
      business: identity.business,
      modeOf: (key) => byKey.get(key)?.mode ?? 'SHADOW',
    };
    this.cache.set(botConfigId, { at: Date.now(), set });
    return set;
  }

  invalidate(botConfigId: string): void {
    this.cache.delete(botConfigId);
  }

  async list(botConfigId: string, tenantId: string) {
    await this.botConfigService.findOne(botConfigId, tenantId);
    const rows = await this.prisma.botIntent.findMany({
      where: { botConfigId },
      orderBy: [{ priority: 'asc' }, { key: 'asc' }],
    });
    return rows.map(toRecord);
  }

  async get(botConfigId: string, tenantId: string, key: string) {
    await this.botConfigService.findOne(botConfigId, tenantId);
    const row = await this.prisma.botIntent.findUnique({
      where: { botConfigId_key: { botConfigId, key } },
    });
    if (!row) throw new NotFoundException(`No existe la intención ${key}`);
    return toRecord(row);
  }

  /**
   * Crea o reemplaza la definición. El modo solo cambia si se envía; una
   * intención nueva nace en SOMBRA salvo que se indique otro.
   */
  async upsert(
    botConfigId: string,
    tenantId: string,
    key: string,
    input: IntentInput,
  ) {
    await this.botConfigService.findOne(botConfigId, tenantId);
    const body = { ...input, key };
    const problems = validateIntentInput(body);
    if (problems.length > 0) {
      throw new BadRequestException({
        message: 'Definición de intención inválida',
        problems,
      });
    }
    await this.assertFallbackExists(botConfigId, body);

    const data = {
      name: String(body.name),
      description: (body.description as string | undefined) ?? '',
      handler: body.handler as IntentHandlerKind,
      priority: (body.priority as number | undefined) ?? 100,
      patterns: (body.patterns ?? []) as Prisma.InputJsonValue,
      denyPatterns: (body.denyPatterns ?? []) as Prisma.InputJsonValue,
      maxTokens: (body.maxTokens as number | undefined) ?? 12,
      respectsOpenFlow: Boolean(body.respectsOpenFlow ?? false),
      allowsQuestion: Boolean(body.allowsQuestion ?? true),
      negationOk: Boolean(body.negationOk ?? false),
      fixedConfidence:
        (body.fixedConfidence as number | null | undefined) ?? null,
      aiClassifiable: Boolean(body.aiClassifiable ?? false),
      config: (body.config ?? {}) as Prisma.InputJsonValue,
      variants: (body.variants ?? {}) as Prisma.InputJsonValue,
      cooldownSeconds: (body.cooldownSeconds as number | undefined) ?? 0,
      schedule: (body.schedule ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      notes: (body.notes as string | undefined) ?? null,
    };
    const mode = body.mode as IntentMode | undefined;

    const row = await this.prisma.botIntent.upsert({
      where: { botConfigId_key: { botConfigId, key } },
      create: { botConfigId, key, ...data, mode: mode ?? 'SHADOW' },
      update: { ...data, ...(mode && { mode }), version: { increment: 1 } },
    });
    this.invalidate(botConfigId);
    return toRecord(row);
  }

  async setMode(
    botConfigId: string,
    tenantId: string,
    key: string,
    mode: IntentMode,
  ) {
    await this.botConfigService.findOne(botConfigId, tenantId);
    if (!['OFF', 'SHADOW', 'ACTIVE'].includes(mode)) {
      throw new BadRequestException('mode inválido');
    }
    const row = await this.prisma.botIntent
      .update({
        where: { botConfigId_key: { botConfigId, key } },
        data: { mode, version: { increment: 1 } },
      })
      .catch(() => null);
    if (!row) throw new NotFoundException(`No existe la intención ${key}`);
    this.invalidate(botConfigId);
    return toRecord(row);
  }

  async remove(botConfigId: string, tenantId: string, key: string) {
    await this.botConfigService.findOne(botConfigId, tenantId);
    await this.prisma.botIntent.deleteMany({ where: { botConfigId, key } });
    this.invalidate(botConfigId);
    return { deleted: true };
  }

  private async assertFallbackExists(botConfigId: string, body: IntentInput) {
    const fallback = (body.config as IntentConfig | undefined)?.fallbackTo;
    if (!fallback) return;
    if (fallback === body.key) {
      throw new BadRequestException('fallbackTo no puede apuntar a sí misma');
    }
    const target = await this.prisma.botIntent.findUnique({
      where: { botConfigId_key: { botConfigId, key: fallback } },
      select: { handler: true },
    });
    if (!target || target.handler !== 'LLM_SLIM') {
      throw new BadRequestException(
        `fallbackTo debe apuntar a una intención LLM_SLIM existente (${fallback})`,
      );
    }
  }

  private async loadRows(botConfigId: string): Promise<Row[]> {
    try {
      return await this.prisma.botIntent.findMany({ where: { botConfigId } });
    } catch (error) {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        this.logger.warn(
          `BotIntent no disponible (¿falta aplicar la migración?): el despachador no clasifica. ${error instanceof Error ? error.message.split('\n').pop() : ''}`,
        );
      }
      return [];
    }
  }

  private async loadIdentity(botConfigId: string) {
    const settings = await this.prisma.botAiSettings.findUnique({
      where: { botConfigId },
      select: { agentName: true, companyName: true },
    });
    return {
      agent: settings?.agentName?.trim() || 'tu asistente',
      business: settings?.companyName?.trim() || 'nuestro equipo',
    };
  }
}

export { RULE_KEY_PREFIX };
