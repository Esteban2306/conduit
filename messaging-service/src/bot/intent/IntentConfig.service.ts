import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { IntentMode, Prisma } from '@prisma/client';
import { PrismaService } from 'src/shared/prisma.service';
import { BotConfigService } from '../config/BotConfigService';
import { DEFAULT_INTENTS, IntentDefinition, IntentId } from './intent-catalog';
import { INTENT_VARIABLES } from './intent-render';

export interface BotIntentSettings {
  modeOf(id: IntentId): IntentMode;
  variantsOf(intent: IntentDefinition, key: string): string[];
  cooldownOf(intent: IntentDefinition): number;
  agent: string;
  business: string;
}

export interface UpsertQuickReplyInput {
  mode?: IntentMode;
  variants?: Record<string, string[]>;
  cooldownSeconds?: number;
}

const CACHE_MS = 30_000;
const MAX_VARIANT_CHARS = 1000;
const MAX_VARIANTS_PER_KEY = 6;

function defaultMode(): IntentMode {
  const value = process.env.INTENT_DEFAULT_MODE;
  return value === 'OFF' || value === 'ACTIVE' ? value : 'SHADOW';
}

/**
 * Modo (apagada / sombra / activa), textos y enfriamiento de cada intención
 * por bot. Sin fila en BotQuickReply rigen los valores del catálogo en modo
 * SOMBRA (clasifica y registra, no responde), así nada cambia hasta activarlo.
 */
@Injectable()
export class IntentConfigService {
  private readonly logger = new Logger(IntentConfigService.name);
  private readonly cache = new Map<
    string,
    { at: number; settings: BotIntentSettings }
  >();
  private warnedUnavailable = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly botConfigService: BotConfigService,
  ) {}

  async forBot(botConfigId: string): Promise<BotIntentSettings> {
    const cached = this.cache.get(botConfigId);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.settings;

    const [rows, identity] = await Promise.all([
      this.loadRows(botConfigId),
      this.loadIdentity(botConfigId),
    ]);
    const byIntent = new Map(rows.map((row) => [row.intent, row]));
    const fallbackMode = defaultMode();

    const settings: BotIntentSettings = {
      modeOf: (id) => byIntent.get(id)?.mode ?? fallbackMode,
      variantsOf: (intent, key) => {
        const custom = (byIntent.get(intent.id)?.variants ?? {}) as Record<
          string,
          unknown
        >;
        const list = custom[key];
        if (Array.isArray(list) && list.every((v) => typeof v === 'string')) {
          const usable = (list as string[]).filter((v) => v.trim() !== '');
          if (usable.length > 0) return usable;
        }
        return intent.variants[key] ?? [];
      },
      cooldownOf: (intent) =>
        byIntent.get(intent.id)?.cooldownSeconds || intent.cooldownSeconds,
      agent: identity.agent,
      business: identity.business,
    };
    this.cache.set(botConfigId, { at: Date.now(), settings });
    return settings;
  }

  async list(botConfigId: string, tenantId: string) {
    await this.botConfigService.findOne(botConfigId, tenantId);
    const rows = await this.prisma.botQuickReply.findMany({
      where: { botConfigId },
    });
    const byIntent = new Map(rows.map((row) => [row.intent, row]));
    const fallbackMode = defaultMode();
    return DEFAULT_INTENTS.map((intent) => {
      const row = byIntent.get(intent.id);
      return {
        intent: intent.id,
        handler: intent.handler,
        mode: row?.mode ?? fallbackMode,
        configured: Boolean(row),
        version: row?.version ?? 0,
        cooldownSeconds: row?.cooldownSeconds || intent.cooldownSeconds,
        variables: INTENT_VARIABLES[intent.id],
        variants: { ...intent.variants, ...((row?.variants as object) ?? {}) },
      };
    });
  }

  async upsert(
    botConfigId: string,
    tenantId: string,
    intentId: string,
    input: UpsertQuickReplyInput,
  ) {
    await this.botConfigService.findOne(botConfigId, tenantId);
    const intent = DEFAULT_INTENTS.find((i) => i.id === intentId);
    if (!intent) {
      throw new BadRequestException(`Intención desconocida: ${intentId}`);
    }
    const variants = input.variants
      ? this.validateVariants(intent, input.variants)
      : undefined;
    if (
      input.cooldownSeconds !== undefined &&
      (!Number.isInteger(input.cooldownSeconds) ||
        input.cooldownSeconds < 0 ||
        input.cooldownSeconds > 86_400)
    ) {
      throw new BadRequestException('cooldownSeconds fuera de rango (0–86400)');
    }
    if (input.mode && !['OFF', 'SHADOW', 'ACTIVE'].includes(input.mode)) {
      throw new BadRequestException('mode inválido');
    }

    const row = await this.prisma.botQuickReply.upsert({
      where: { botConfigId_intent: { botConfigId, intent: intentId } },
      create: {
        botConfigId,
        intent: intentId,
        mode: input.mode ?? defaultMode(),
        variants: (variants ?? {}) as Prisma.InputJsonValue,
        cooldownSeconds: input.cooldownSeconds ?? 0,
      },
      update: {
        ...(input.mode && { mode: input.mode }),
        ...(variants && { variants: variants as Prisma.InputJsonValue }),
        ...(input.cooldownSeconds !== undefined && {
          cooldownSeconds: input.cooldownSeconds,
        }),
        version: { increment: 1 },
      },
    });
    this.cache.delete(botConfigId);
    return row;
  }

  private validateVariants(
    intent: IntentDefinition,
    variants: Record<string, string[]>,
  ): Record<string, string[]> {
    const allowed = new Set(INTENT_VARIABLES[intent.id]);
    const clean: Record<string, string[]> = {};
    for (const [key, list] of Object.entries(variants)) {
      if (!(key in intent.variants)) {
        throw new BadRequestException(
          `La intención ${intent.id} no tiene la variante "${key}"`,
        );
      }
      if (
        !Array.isArray(list) ||
        list.length === 0 ||
        list.length > MAX_VARIANTS_PER_KEY
      ) {
        throw new BadRequestException(
          `"${key}" debe tener entre 1 y ${MAX_VARIANTS_PER_KEY} textos`,
        );
      }
      for (const text of list) {
        if (
          typeof text !== 'string' ||
          text.trim() === '' ||
          text.length > MAX_VARIANT_CHARS
        ) {
          throw new BadRequestException(
            `Cada texto debe ser no vacío y de máximo ${MAX_VARIANT_CHARS} caracteres`,
          );
        }
        for (const name of text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
          if (!allowed.has(name[1])) {
            throw new BadRequestException(
              `Variable {{${name[1]}}} no disponible en ${intent.id}. Disponibles: ${[...allowed].join(', ') || 'ninguna'}`,
            );
          }
        }
      }
      clean[key] = list;
    }
    return clean;
  }

  private async loadRows(botConfigId: string) {
    try {
      return await this.prisma.botQuickReply.findMany({
        where: { botConfigId },
      });
    } catch (error) {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        this.logger.warn(
          `BotQuickReply no disponible (¿falta aplicar la migración?): se usan los valores por defecto en modo ${defaultMode()}. ${error instanceof Error ? error.message.split('\n').pop() : ''}`,
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
