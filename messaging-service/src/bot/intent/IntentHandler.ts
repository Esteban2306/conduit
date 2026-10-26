import { Injectable, Logger } from '@nestjs/common';
import { isLidAddress } from 'src/channels/whatsapp/utils/jid.util';
import { HandoffService } from '../handoff/Handoff.service';
import { ConversationService } from '../conversation/ConversationService';
import { BotEscalationService } from '../tools/BotEscalation.service';
import { ResolvedTool } from '../tools/ToolDefinitionService';
import { ToolExecutorService } from '../tools/ToolExecutor.service';
import { HardRulesService } from './HardRules.service';
import {
  AI_CLASSIFIER_MAX_WORDS,
  IntentAiClassifier,
} from './IntentAiClassifier';
import { BotIntentSet, IntentRepository } from './IntentRepository.service';
import { Classification, IntentResolver } from './IntentResolver';
import { IntentMetricsService } from './intent-metrics.service';
import {
  ACTIVE_FLOW_KEY,
  IntentOutcome,
  TASK_DONE_KEY,
  isTaskDone,
  IntentTurn,
  SlimPlan,
} from './intent-turn';
import { IntentRecord } from './intent-types';
import { fillTemplate, renderTool } from './render-spec';
import { isAffirmation, normalizeText, tokenCount } from './normalize';

const OPEN_QUESTION_TTL_MS = 30 * 60 * 1000;
const FALSE_POSITIVE_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_FLOW_TTL_MINUTES = 30;
const TOOL_CACHE_MAX = 200;

interface LastHandled {
  intent: string;
  normalized: string;
  at: number;
}

type Produced = { text: string } | { slim: SlimPlan } | null;

/**
 * Decide por turno el manejador más barato: reglas duras → continuidad de un
 * flujo abierto → clasificación determinística → clasificador de IA mínimo →
 * manejador de la intención (plantilla, llamada directa, traspaso o LLM
 * reducido). Si algo falla el turno sigue a la IA completa: nunca silencio.
 */
@Injectable()
export class IntentHandler {
  private readonly logger = new Logger(IntentHandler.name);
  private readonly lastVariant = new Map<string, number>();
  private readonly lastFired = new Map<string, number>();
  private readonly lastHandled = new Map<string, LastHandled>();
  private readonly toolCache = new Map<
    string,
    { body: unknown; expires: number }
  >();

  constructor(
    private readonly resolver: IntentResolver,
    private readonly repository: IntentRepository,
    private readonly hardRules: HardRulesService,
    private readonly aiClassifier: IntentAiClassifier,
    private readonly metrics: IntentMetricsService,
    private readonly toolExecutor: ToolExecutorService,
    private readonly conversationService: ConversationService,
    private readonly botEscalation: BotEscalationService,
    private readonly handoffService: HandoffService,
  ) {}

  async handle(turn: IntentTurn): Promise<IntentOutcome> {
    if (turn.hasImage || turn.text.trim() === '') return { handled: false };
    try {
      return await this.run(turn);
    } catch (error) {
      this.metrics.count('error');
      this.logger.error(
        `Fallo del despachador de intenciones en ${turn.conversationId}; el turno sigue a la IA: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { handled: false };
    }
  }

  /** Clasifica sin efectos (para probar frases desde el panel/API). */
  async dryRun(
    botConfigId: string,
    text: string,
    openFlow = false,
  ): Promise<Classification> {
    const set = await this.repository.forBot(botConfigId);
    return this.resolver.classify(
      text,
      { openFlow, timeZone: this.repository.timeZone() },
      set.compiled,
    );
  }

  /** El router avisa tras un turno LLM_SLIM exitoso: abre, renueva o cierra el flujo. */
  async afterSlimTurn(
    conversationId: string,
    plan: SlimPlan,
    executedTools: string[],
  ): Promise<void> {
    const ended = (plan.endsOnTools ?? []).some((t) =>
      executedTools.includes(t),
    );
    const ttl = (plan.flowTtlMinutes ?? DEFAULT_FLOW_TTL_MINUTES) * 60_000;
    await this.conversationService.updateContext(conversationId, {
      contextPatch: {
        [ACTIVE_FLOW_KEY]: ended
          ? null
          : {
              intent: plan.intentKey,
              until: new Date(Date.now() + ttl).toISOString(),
            },
        [TASK_DONE_KEY]: ended ? new Date().toISOString() : null,
      },
    });
    this.metrics.count(
      ended ? `flow:${plan.intentKey}:ended` : `flow:${plan.intentKey}:open`,
    );
  }

  private async run(turn: IntentTurn): Promise<IntentOutcome> {
    const started = Date.now();
    const set = await this.repository.forBot(turn.botConfigId);
    this.trackRepeats(turn, set);

    if (await this.hardRules.apply(turn)) return { handled: true };
    if (isTaskDone(turn.context) && isAffirmation(turn.text)) {
      await this.conversationService.ignorePending(turn.pendingIds ?? []);
      this.metrics.count('silent-after-task:affirmation');
      return { handled: true };
    }

    if (set.compiled.length === 0) return { handled: false };

    const flowIntent = this.activeFlow(turn, set);
    const openQuestion =
      !isTaskDone(turn.context) &&
      turn.lastBotMessage !== null &&
      turn.lastBotMessage.content.includes('?') &&
      Date.now() - turn.lastBotMessage.at.getTime() < OPEN_QUESTION_TTL_MS;

    const timeZone = this.repository.timeZone();
    let result: Classification = this.resolver.classify(
      turn.text,
      { openFlow: openQuestion || flowIntent !== null, timeZone },
      set.compiled,
    );
    let via: 'rules' | 'ai' = 'rules';

    if (
      !result.decided &&
      !flowIntent &&
      (result.reason === 'no-match' || result.reason === 'low-confidence')
    ) {
      const ai = await this.classifyWithAi(turn, set);
      if (ai) {
        result = ai;
        via = 'ai';
      }
    }

    if (!result.decided) {
      this.metrics.count(
        `undecided:${result.reason}${result.candidate ? `:${result.candidate}` : ''}`,
      );
      if (flowIntent) return this.continueFlow(turn, flowIntent);
      return { handled: false };
    }

    const intent = result.intent;
    const base = {
      conversationId: turn.conversationId,
      intent: intent.key,
      handler: intent.handler,
      mode: intent.mode,
      confidence: result.confidence,
    };

    if (intent.mode === 'SHADOW') {
      this.metrics.record({
        ...base,
        outcome: via === 'ai' ? 'shadow-ai' : 'shadow',
      });
      return flowIntent
        ? this.continueFlow(turn, flowIntent)
        : { handled: false };
    }

    if (flowIntent && flowIntent.key !== intent.key) {
      await this.clearFlow(turn);
    }

    if (intent.config.silentAfterTask && isTaskDone(turn.context)) {
      await this.conversationService.ignorePending(turn.pendingIds ?? []);
      this.metrics.record({ ...base, outcome: 'silent-after-task' });
      return { handled: true };
    }

    const fireKey = `${turn.conversationId}|${intent.key}`;
    const previousFire = this.lastFired.get(fireKey);
    if (
      intent.cooldownSeconds > 0 &&
      previousFire &&
      Date.now() - previousFire < intent.cooldownSeconds * 1000
    ) {
      this.metrics.record({ ...base, outcome: 'cooldown' });
      return { handled: false };
    }

    let produced = await this.produce(turn, intent, set, result.entity, via);
    if (produced === null && intent.config.fallbackTo) {
      const target = set.byKey.get(intent.config.fallbackTo);
      if (target && target.handler === 'LLM_SLIM' && target.mode === 'ACTIVE') {
        produced = { slim: this.planOf(target, 'fallback', turn) };
      }
    }

    if (produced === null) {
      this.metrics.record({
        ...base,
        outcome: 'fallback',
        latencyMs: Date.now() - started,
      });
      return { handled: false };
    }

    if ('slim' in produced) {
      this.metrics.record({
        ...base,
        intent: produced.slim.intentKey,
        handler: 'LLM_SLIM',
        outcome: `slim-${produced.slim.via}`,
        latencyMs: Date.now() - started,
      });
      return { handled: false, slim: produced.slim };
    }

    let text = produced.text;
    if (intent.config.greetFirstContact && turn.lastBotMessage === null) {
      const prefix = await this.greetingPrefix(turn, intent, set);
      if (prefix) text = `${prefix}\n\n${text}`;
    }
    await turn.send(text);
    this.lastFired.set(fireKey, Date.now());
    this.lastHandled.set(turn.conversationId, {
      intent: intent.key,
      normalized: result.normalized,
      at: Date.now(),
    });
    this.metrics.record({
      ...base,
      outcome: via === 'ai' ? 'handled-ai' : 'handled',
      latencyMs: Date.now() - started,
    });
    return { handled: true };
  }

  private activeFlow(turn: IntentTurn, set: BotIntentSet): IntentRecord | null {
    const flow = turn.context[ACTIVE_FLOW_KEY] as
      | { intent?: string; until?: string }
      | null
      | undefined;
    if (!flow?.intent || !flow.until) return null;
    if (new Date(flow.until).getTime() <= Date.now()) return null;
    const record = set.byKey.get(flow.intent);
    return record && record.handler === 'LLM_SLIM' && record.mode === 'ACTIVE'
      ? record
      : null;
  }

  private continueFlow(turn: IntentTurn, intent: IntentRecord): IntentOutcome {
    this.metrics.record({
      conversationId: turn.conversationId,
      intent: intent.key,
      handler: 'LLM_SLIM',
      mode: intent.mode,
      outcome: 'slim-flow',
    });
    return { handled: false, slim: this.planOf(intent, 'flow', turn) };
  }

  private async clearFlow(turn: IntentTurn): Promise<void> {
    await this.conversationService.updateContext(turn.conversationId, {
      contextPatch: { [ACTIVE_FLOW_KEY]: null },
    });
  }

  private planOf(
    intent: IntentRecord,
    via: SlimPlan['via'],
    turn: IntentTurn,
  ): SlimPlan {
    const slim = intent.config.slim!;
    const confirmed =
      Boolean(slim.confirmHint) &&
      turn.lastBotMessage?.content.includes('?') === true &&
      isAffirmation(turn.text);
    return {
      ...slim,
      intentKey: intent.key,
      via,
      ...(confirmed && { hint: slim.confirmHint }),
    };
  }

  private async classifyWithAi(
    turn: IntentTurn,
    set: BotIntentSet,
  ): Promise<Classification | null> {
    const normalized = normalizeText(turn.text);
    if (
      /\n/.test(turn.text.trim()) ||
      tokenCount(normalized) > AI_CLASSIFIER_MAX_WORDS
    ) {
      return null;
    }

    const candidates = set.all.filter(
      (i) =>
        i.aiClassifiable &&
        i.mode === 'ACTIVE' &&
        i.handler !== 'HANDOFF' &&
        !JSON.stringify(i.config.params ?? {}).includes('$entity'),
    );
    if (candidates.length === 0) return null;

    const answer = await this.aiClassifier.classify(
      turn.botConfigId,
      turn.conversationId,
      turn.text,
      normalized,
      candidates,
      turn.lastBotMessage?.content ?? null,
    );
    if (!answer) return null;
    if (!answer.key) {
      this.metrics.count('ai-classifier:none');
      return null;
    }
    const intent = candidates.find((c) => c.key === answer.key);
    if (!intent) {
      this.metrics.count('ai-classifier:invalid');
      return null;
    }
    this.metrics.count(
      `ai-classifier:${intent.key}${answer.cached ? ':cached' : ''}`,
    );
    return {
      decided: true,
      intent,
      confidence: 0.7,
      normalized,
    };
  }

  private async produce(
    turn: IntentTurn,
    intent: IntentRecord,
    set: BotIntentSet,
    entity: string | undefined,
    via: 'rules' | 'ai',
  ): Promise<Produced> {
    if (intent.handler === 'LLM_SLIM') {
      return intent.config.slim
        ? { slim: this.planOf(intent, via, turn) }
        : null;
    }

    const vars: Record<string, string> = {
      agente: set.agent,
      negocio: set.business,
    };
    let variantKey = 'default';

    if (intent.handler === 'TOOL_DIRECT') {
      const called = await this.callTool(turn, intent, entity);
      if (called === 'failed') return null;
      if (called === 'skip-identity' && !intent.config.identityOptional) {
        return null;
      }
      const data = called === 'skip-identity' ? null : called.body;
      const rendered = renderTool(data, intent.config.render!, {
        timeZone: this.repository.timeZone(),
        extras: { entity, text: turn.text },
      });
      if (!rendered) return null;
      variantKey = rendered.variantKey;
      Object.assign(vars, rendered.vars);
    } else if (intent.handler === 'HANDOFF') {
      const result = await this.handoffService.perform({
        tenantId: turn.tenantId,
        botConfigId: turn.botConfigId,
        conversationId: turn.conversationId,
        connectionId: turn.connectionId,
        phoneNumber: turn.phoneNumber,
        turnId: turn.turnId,
        reason: intent.config.reason ?? intent.name,
        summary: `Mensaje de la clienta: "${turn.text.slice(0, 300)}"`,
        context: turn.context,
        loadTools: turn.loadTools,
        toolName: intent.config.tool,
      });
      if (!result.notified) return { text: result.text };
    }

    const variants = intent.variants[variantKey] ?? [];
    if (variants.length === 0) return null;
    const chosen = this.pickVariant(turn.conversationId, intent.key, variants);
    const text = fillTemplate(variants[chosen], vars);
    if (text === null) {
      this.logger.warn(
        `La plantilla de "${intent.key}" (${variantKey}) tiene variables sin valor; el turno sigue a la IA.`,
      );
      return null;
    }
    return { text };
  }

  /**
   * Primer mensaje del bot en esta conversación: se antepone el saludo
   * (con el nombre si ya es clienta) a la respuesta, para no gastar un
   * turno de IA en presentarse. Si el saludo no se puede armar, la
   * respuesta sale sola.
   */
  private async greetingPrefix(
    turn: IntentTurn,
    answering: IntentRecord,
    set: BotIntentSet,
  ): Promise<string | null> {
    const source = set.all.find(
      (i) => i.config.greetingSource && i.mode === 'ACTIVE',
    );
    if (!source) return null;

    let data: unknown = null;
    if (source.config.tool) {
      const called = await this.callTool(turn, source, undefined);
      if (called === 'failed') return null;
      if (called === 'skip-identity' && !source.config.identityOptional) {
        return null;
      }
      data = called === 'skip-identity' ? null : called.body;
    }
    const rendered = source.config.render
      ? renderTool(data, source.config.render, {
          timeZone: this.repository.timeZone(),
        })
      : { variantKey: 'default', vars: {} as Record<string, string> };
    if (!rendered) return null;

    const variants = source.variants[`prefix_${rendered.variantKey}`] ?? [];
    if (variants.length === 0) return null;
    const chosen = this.pickVariant(
      turn.conversationId,
      `${answering.key}:prefix`,
      variants,
    );
    return fillTemplate(variants[chosen], {
      agente: set.agent,
      negocio: set.business,
      ...rendered.vars,
    });
  }

  private pickVariant(
    conversationId: string,
    key: string,
    variants: string[],
  ): number {
    const mapKey = `${conversationId}|${key}`;
    const previous = this.lastVariant.get(mapKey);
    const next =
      previous === undefined
        ? Math.floor(Math.random() * variants.length)
        : (previous + 1) % variants.length;
    this.lastVariant.set(mapKey, next);
    return next;
  }

  private async callTool(
    turn: IntentTurn,
    intent: IntentRecord,
    entity: string | undefined,
  ): Promise<{ body: unknown } | 'failed' | 'skip-identity'> {
    const config = intent.config;
    const tools = await turn.loadTools();
    const resolved = tools.find((t) => t.spec.name === config.tool);
    if (!resolved) {
      this.metrics.count(`tool-missing:${config.tool}`);
      return 'failed';
    }
    const needsPhone = resolved.injectPhoneParamName !== null;
    if (needsPhone && isLidAddress(turn.phoneNumber)) return 'skip-identity';

    const params = this.buildParams(intent, turn, entity);
    if (params === null) return 'failed';

    const cacheKey = this.cacheKey(turn, intent, params);
    if (cacheKey) {
      const hit = this.toolCache.get(cacheKey);
      if (hit && hit.expires > Date.now()) {
        this.metrics.count(`tool-cache-hit:${config.tool}`);
        return { body: hit.body };
      }
    }

    const outcome = await this.toolExecutor.execute({
      toolDefinitionId: resolved.definitionId,
      conversationId: turn.conversationId,
      params,
      injectedPhone: needsPhone ? turn.phoneNumber : undefined,
      phoneParamName: resolved.injectPhoneParamName ?? undefined,
      contactAddress: turn.phoneNumber,
      turnId: turn.turnId,
    });
    await this.remember(turn, config.tool!, params, outcome);

    if (outcome.status === 'SUCCESS') {
      if (cacheKey && config.cache) {
        if (this.toolCache.size >= TOOL_CACHE_MAX) {
          const oldest = this.toolCache.keys().next().value;
          if (oldest !== undefined) this.toolCache.delete(oldest);
        }
        this.toolCache.set(cacheKey, {
          body: outcome.responseBody,
          expires: Date.now() + config.cache.seconds * 1000,
        });
      }
      return { body: outcome.responseBody };
    }

    if (outcome.status === 'TECHNICAL_ERROR') {
      try {
        await this.botEscalation.notifyToolFailure(
          turn.tenantId,
          turn.botConfigId,
          outcome.status,
          config.tool!,
          turn.phoneNumber,
          outcome.errorDetail,
        );
      } catch (error) {
        this.logger.error(
          `No fue posible avisar del fallo de "${config.tool}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return 'failed';
  }

  private buildParams(
    intent: IntentRecord,
    turn: IntentTurn,
    entity: string | undefined,
  ): Record<string, unknown> | null {
    const params: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(intent.config.params ?? {})) {
      if (value === '$entity') {
        if (!entity) return null;
        params[name] = entity;
      } else if (value === '$text') {
        params[name] = turn.text.slice(0, 300);
      } else {
        params[name] = value;
      }
    }
    if (intent.handler === 'HANDOFF') {
      params.reason = intent.config.reason ?? 'Solicitud de la clienta';
      params.summary = `Mensaje de la clienta: "${turn.text.slice(0, 300)}"`;
    }
    return params;
  }

  private cacheKey(
    turn: IntentTurn,
    intent: IntentRecord,
    params: Record<string, unknown>,
  ): string | null {
    const cache = intent.config.cache;
    if (!cache) return null;
    const who = cache.scope === 'contact' ? turn.phoneNumber : '';
    return `${turn.botConfigId}|${intent.config.tool}|${who}|${JSON.stringify(params)}`;
  }

  private async remember(
    turn: IntentTurn,
    tool: string,
    params: Record<string, unknown>,
    outcome: {
      status: string;
      responseBody: unknown;
      errorDetail: string | null;
    },
  ): Promise<void> {
    try {
      const compact = (value: unknown, max: number) => {
        const raw = JSON.stringify(value) ?? '';
        return raw.length > max ? `${raw.slice(0, max)}…` : raw;
      };
      await this.conversationService.appendActionMemory(turn.conversationId, {
        herramienta: tool,
        parametros: compact(params, 200),
        estado: outcome.status,
        resultado:
          outcome.status === 'SUCCESS'
            ? compact(outcome.responseBody, 600)
            : (outcome.errorDetail ?? compact(outcome.responseBody, 300)),
        en: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.warn(
        `No fue posible guardar la memoria de "${tool}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Señal de falso positivo: tras una respuesta automática, la clienta repite
   * lo mismo o pide una persona.
   */
  private trackRepeats(turn: IntentTurn, set: BotIntentSet): void {
    const previous = this.lastHandled.get(turn.conversationId);
    if (!previous) return;
    if (Date.now() - previous.at > FALSE_POSITIVE_WINDOW_MS) {
      this.lastHandled.delete(turn.conversationId);
      return;
    }
    if (normalizeText(turn.text) === previous.normalized) {
      this.metrics.count(`false-positive-signal:${previous.intent}:repeated`);
      return;
    }
    const next = this.resolver.classify(
      turn.text,
      { openFlow: false, timeZone: this.repository.timeZone() },
      set.compiled,
    );
    if (next.decided && next.intent.handler === 'HANDOFF') {
      this.metrics.count(
        `false-positive-signal:${previous.intent}:asked-human`,
      );
    }
  }
}
