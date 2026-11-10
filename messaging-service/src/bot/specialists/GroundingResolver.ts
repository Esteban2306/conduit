import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/shared/prisma.service';
import { maskSecrets } from 'src/shared/security/mask-secrets';
import { ToolInvocationStatus } from '@prisma/client';
import { TurnBudget } from '../ai/turn-budget';
import {
  ResolvedTool,
  ToolDefinitionService,
} from '../tools/ToolDefinitionService';
import { ToolExecutorService } from '../tools/ToolExecutor.service';
import { ContextSource } from './contracts';
import { GroundingValue, GroundingValues } from './rule-evaluator';
import { readPath, toGroundingValue } from './value-path';

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_CACHE_ENTRIES = 500;

export type GroundingFailure =
  | 'TOOL_NOT_FOUND'
  | 'TOOL_NOT_ALLOWED'
  | 'TOOL_FAILED'
  | 'MAPPING_NOT_FOUND'
  | 'TIMEOUT'
  | 'VALUE_MISSING'
  | 'VALUE_NOT_SCALAR'
  | 'ERROR';

export interface GroundingRequest {
  tenantId: string;
  botConfigId: string;
  conversationId: string;
  contactAddress?: string;
  sources: ContextSource[];
  neededKeys: ReadonlySet<string>;
}

export interface GroundingOutcome {
  values: GroundingValues;
  unavailable: Array<{ key: string; reason: GroundingFailure }>;
  requiredUnavailable: boolean;
}

type Loaded =
  | { ok: true; value: Exclude<GroundingValue, null | undefined> }
  | { ok: false; reason: GroundingFailure };

interface CacheEntry {
  value: Exclude<GroundingValue, null | undefined>;
  expiresAt: number;
}

@Injectable()
export class GroundingResolver {
  private readonly logger = new Logger(GroundingResolver.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<Loaded>>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly tools: ToolDefinitionService,
    private readonly executor: ToolExecutorService,
  ) {}

  timeoutMs(): number {
    const configured = this.config.get<number>(
      'specialists.groundingTimeoutMs',
    );
    return Number.isFinite(configured)
      ? (configured as number)
      : DEFAULT_TIMEOUT_MS;
  }

  async resolve(request: GroundingRequest): Promise<GroundingOutcome> {
    const wanted = request.sources.filter(
      (source) => source.required || request.neededKeys.has(source.key),
    );
    const outcome: GroundingOutcome = {
      values: {},
      unavailable: [],
      requiredUnavailable: false,
    };
    if (wanted.length === 0) return outcome;

    const budget = new TurnBudget(this.timeoutMs());
    let toolsPromise: Promise<ResolvedTool[]> | null = null;
    const toolsOf = () => {
      toolsPromise ??= this.tools.getActiveToolsForBot(request.botConfigId);
      return toolsPromise;
    };

    const failed: Loaded = { ok: false, reason: 'ERROR' };
    const loaded = await Promise.all(
      wanted.map((source) =>
        this.load(request, source, budget, toolsOf).catch(() => failed),
      ),
    );

    wanted.forEach((source, index) => {
      const result = loaded[index];
      if (result.ok) {
        outcome.values[source.key] = result.value;
        return;
      }
      outcome.unavailable.push({ key: source.key, reason: result.reason });
      if (source.required) outcome.requiredUnavailable = true;
      this.logger.warn(
        `Contexto "${source.key}" no disponible (${result.reason}) para la conversación ${request.conversationId}`,
      );
    });

    return outcome;
  }

  private async load(
    request: GroundingRequest,
    source: ContextSource,
    budget: TurnBudget,
    toolsOf: () => Promise<ResolvedTool[]>,
  ): Promise<Loaded> {
    const ttlMs = source.maxAgeSeconds * 1000;
    const cacheKey = [
      request.tenantId,
      request.botConfigId,
      request.conversationId,
      source.kind,
      source.name,
      source.valuePath ?? '',
    ].join('|');

    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now())
      return { ok: true, value: hit.value };

    const pending = this.inFlight.get(cacheKey);
    if (pending) return pending;

    const work = (async (): Promise<Loaded> => {
      try {
        const result = await budget.race(
          source.kind === 'TOOL'
            ? this.fromTool(request, source, budget, toolsOf)
            : this.fromMapping(request, source),
        );
        if (result.ok && ttlMs > 0)
          this.remember(cacheKey, result.value, ttlMs);
        return result;
      } catch (error) {
        const reason: GroundingFailure =
          error instanceof Error && error.name === 'TimeoutError'
            ? 'TIMEOUT'
            : 'ERROR';
        if (reason === 'ERROR') {
          this.logger.warn(
            `Falló la consulta de contexto "${source.key}": ${maskSecrets(
              error instanceof Error ? error.message : String(error),
            )}`,
          );
        }
        return { ok: false, reason };
      } finally {
        this.inFlight.delete(cacheKey);
      }
    })();

    this.inFlight.set(cacheKey, work);
    return work;
  }

  private async fromTool(
    request: GroundingRequest,
    source: ContextSource,
    budget: TurnBudget,
    toolsOf: () => Promise<ResolvedTool[]>,
  ): Promise<Loaded> {
    const tool = (await toolsOf()).find((t) => t.spec.name === source.name);
    if (!tool) return { ok: false, reason: 'TOOL_NOT_FOUND' };
    if (
      !tool.readOnly ||
      tool.requiresImageAttachment ||
      tool.pausesBotMinutes
    ) {
      return { ok: false, reason: 'TOOL_NOT_ALLOWED' };
    }

    const address = request.contactAddress;
    const injectPhone =
      tool.injectPhoneParamName && address && !address.endsWith('@lid');

    const outcome = await this.executor.execute({
      toolDefinitionId: tool.definitionId,
      conversationId: request.conversationId,
      params: {},
      injectedPhone: injectPhone ? address : undefined,
      phoneParamName: injectPhone
        ? (tool.injectPhoneParamName ?? undefined)
        : undefined,
      contactAddress: address,
      deadlineAt: budget.deadlineAt,
    });
    if (outcome.status !== ToolInvocationStatus.SUCCESS) {
      return { ok: false, reason: 'TOOL_FAILED' };
    }
    return this.extract(outcome.responseBody, source.valuePath);
  }

  private async fromMapping(
    request: GroundingRequest,
    source: ContextSource,
  ): Promise<Loaded> {
    const dot = source.name.indexOf('.');
    const namespace = source.name.slice(0, dot);
    const key = source.name.slice(dot + 1);

    const row = await this.prisma.externalVariable.findFirst({
      where: {
        botConfigId: request.botConfigId,
        namespace,
        key,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { value: true },
    });
    if (!row) return { ok: false, reason: 'MAPPING_NOT_FOUND' };

    if (!source.valuePath) return this.extract(row.value, undefined);
    try {
      return this.extract(JSON.parse(row.value) as unknown, source.valuePath);
    } catch {
      return { ok: false, reason: 'VALUE_NOT_SCALAR' };
    }
  }

  private extract(body: unknown, path: string | undefined): Loaded {
    const raw = path ? readPath(body, path) : body;
    if (raw === undefined || raw === null) {
      return { ok: false, reason: 'VALUE_MISSING' };
    }
    const value = toGroundingValue(raw);
    return value === undefined || value === null
      ? { ok: false, reason: 'VALUE_NOT_SCALAR' }
      : { ok: true, value };
  }

  private remember(
    key: string,
    value: Exclude<GroundingValue, null | undefined>,
    ttlMs: number,
  ): void {
    this.cache.delete(key);
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
