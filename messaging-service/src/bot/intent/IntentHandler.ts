import { Injectable, Logger } from '@nestjs/common';
import { ConversationService } from '../conversation/ConversationService';
import { isLidAddress } from 'src/channels/whatsapp/utils/jid.util';
import { BotEscalationService } from '../tools/BotEscalation.service';
import { ResolvedTool } from '../tools/ToolDefinitionService';
import { ToolExecutorService } from '../tools/ToolExecutor.service';
import { IntentConfigService } from './IntentConfig.service';
import { IntentResolver } from './IntentResolver';
import { IntentDefinition } from './intent-catalog';
import { IntentMetricsService } from './intent-metrics.service';
import { RENDERERS, Rendered, fillTemplate } from './intent-render';
import { normalizeText } from './normalize';

export interface IntentTurn {
  tenantId: string;
  botConfigId: string;
  conversationId: string;
  phoneNumber: string;
  connectionId: string;
  text: string;
  hasImage: boolean;
  turnId: string;
  lastBotMessage: { content: string; at: Date } | null;
  loadTools: () => Promise<ResolvedTool[]>;
  send: (text: string) => Promise<void>;
}

export interface IntentOutcome {
  handled: boolean;
}

const OPEN_FLOW_TTL_MS = 30 * 60 * 1000;
const FALSE_POSITIVE_WINDOW_MS = 10 * 60 * 1000;

interface LastHandled {
  intent: string;
  normalized: string;
  at: number;
}

/**
 * Decide por turno el manejador más barato: clasifica con el
 * IntentResolver y, según el modo de la intención, solo registra (SOMBRA) o
 * responde con plantilla / llamada directa al backend / traspaso, sin IA.
 * Si algo falla devuelve `handled: false` y el turno sigue a la IA: nunca
 * deja a la clienta sin respuesta.
 */
@Injectable()
export class IntentHandler {
  private readonly logger = new Logger(IntentHandler.name);
  private readonly lastVariant = new Map<string, number>();
  private readonly lastFired = new Map<string, number>();
  private readonly lastHandled = new Map<string, LastHandled>();

  constructor(
    private readonly resolver: IntentResolver,
    private readonly config: IntentConfigService,
    private readonly metrics: IntentMetricsService,
    private readonly toolExecutor: ToolExecutorService,
    private readonly conversationService: ConversationService,
    private readonly botEscalation: BotEscalationService,
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

  private async run(turn: IntentTurn): Promise<IntentOutcome> {
    const started = Date.now();
    this.trackRepeats(turn);

    const openFlow =
      turn.lastBotMessage !== null &&
      turn.lastBotMessage.content.includes('?') &&
      Date.now() - turn.lastBotMessage.at.getTime() < OPEN_FLOW_TTL_MS;

    const result = this.resolver.classify(turn.text, { openFlow });
    if (!result.decided) {
      this.metrics.count(
        `undecided:${result.reason}${result.candidate ? `:${result.candidate}` : ''}`,
      );
      return { handled: false };
    }

    const { intent, confidence } = result;
    const settings = await this.config.forBot(turn.botConfigId);
    const mode = settings.modeOf(intent.id);
    const base = {
      conversationId: turn.conversationId,
      intent: intent.id,
      handler: intent.handler,
      mode,
      confidence,
    };

    if (mode === 'OFF') return { handled: false };
    if (mode === 'SHADOW') {
      this.metrics.record({ ...base, outcome: 'shadow' });
      return { handled: false };
    }

    const cooldown = settings.cooldownOf(intent);
    const fireKey = `${turn.conversationId}|${intent.id}`;
    const previousFire = this.lastFired.get(fireKey);
    if (
      cooldown > 0 &&
      previousFire &&
      Date.now() - previousFire < cooldown * 1000
    ) {
      this.metrics.record({ ...base, outcome: 'cooldown' });
      return { handled: false };
    }

    const reply = await this.produce(turn, intent, settings);
    if (reply === null) {
      this.metrics.record({
        ...base,
        outcome: 'fallback',
        latencyMs: Date.now() - started,
      });
      return { handled: false };
    }

    await turn.send(reply);
    this.lastFired.set(fireKey, Date.now());
    this.lastHandled.set(turn.conversationId, {
      intent: intent.id,
      normalized: result.normalized,
      at: Date.now(),
    });
    this.metrics.record({
      ...base,
      outcome: 'handled',
      latencyMs: Date.now() - started,
    });
    return { handled: true };
  }

  private async produce(
    turn: IntentTurn,
    intent: IntentDefinition,
    settings: Awaited<ReturnType<IntentConfigService['forBot']>>,
  ): Promise<string | null> {
    const renderer = RENDERERS[intent.id];
    if (!renderer) return null;

    let data: unknown = null;
    if (intent.tool) {
      const tools = await turn.loadTools();
      const called = await this.callTool(turn, intent, tools);
      if (called === 'skip-identity' && intent.identityOptional) {
        data = null;
      } else if (called === 'skip-identity' || called === 'failed') {
        return null;
      } else {
        data = called.body;
      }
      if (intent.handler === 'HANDOFF') {
        const minutes = tools.find(
          (t) => t.spec.name === intent.tool,
        )?.pausesBotMinutes;
        if (minutes) {
          await this.conversationService.pauseBot(
            turn.conversationId,
            minutes,
            `Traspaso a una persona (${intent.id})`,
          );
        }
      }
    }

    const rendered: Rendered | null = renderer(data);
    if (!rendered) return null;

    const variants = settings.variantsOf(intent, rendered.variantKey);
    if (variants.length === 0) return null;

    const vars = {
      agente: settings.agent,
      negocio: settings.business,
      ...rendered.vars,
    };
    const chosen = this.pickVariant(turn.conversationId, intent.id, variants);
    const text = fillTemplate(variants[chosen], vars);
    if (text === null) {
      this.logger.warn(
        `La plantilla de "${intent.id}" (${rendered.variantKey}) tiene variables sin valor; el turno sigue a la IA.`,
      );
      return null;
    }
    return text;
  }

  private pickVariant(
    conversationId: string,
    intent: string,
    variants: string[],
  ): number {
    const key = `${conversationId}|${intent}`;
    const previous = this.lastVariant.get(key);
    const next =
      previous === undefined
        ? Math.floor(Math.random() * variants.length)
        : (previous + 1) % variants.length;
    this.lastVariant.set(key, next);
    return next;
  }

  private async callTool(
    turn: IntentTurn,
    intent: IntentDefinition,
    tools: ResolvedTool[],
  ): Promise<{ body: unknown } | 'failed' | 'skip-identity'> {
    const resolved = tools.find((t) => t.spec.name === intent.tool);
    if (!resolved) {
      this.metrics.count(`tool-missing:${intent.tool}`);
      return 'failed';
    }
    const needsPhone = resolved.injectPhoneParamName !== null;
    if (needsPhone && isLidAddress(turn.phoneNumber)) return 'skip-identity';

    const params: Record<string, unknown> =
      intent.handler === 'HANDOFF'
        ? {
            reason: intent.handoffReason ?? 'Solicitud de la clienta',
            summary: `Mensaje de la clienta: "${turn.text.slice(0, 300)}"`,
          }
        : {};

    const outcome = await this.toolExecutor.execute({
      toolDefinitionId: resolved.definitionId,
      conversationId: turn.conversationId,
      params,
      injectedPhone: needsPhone ? turn.phoneNumber : undefined,
      phoneParamName: resolved.injectPhoneParamName ?? undefined,
      contactAddress: turn.phoneNumber,
      turnId: turn.turnId,
    });

    await this.remember(turn, intent.tool!, params, outcome);

    if (outcome.status === 'SUCCESS') return { body: outcome.responseBody };

    if (outcome.status === 'TECHNICAL_ERROR') {
      try {
        await this.botEscalation.notifyToolFailure(
          turn.tenantId,
          turn.botConfigId,
          outcome.status,
          intent.tool!,
          turn.phoneNumber,
          outcome.errorDetail,
        );
      } catch (error) {
        this.logger.error(
          `No fue posible avisar del fallo de "${intent.tool}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return 'failed';
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
  private trackRepeats(turn: IntentTurn): void {
    const previous = this.lastHandled.get(turn.conversationId);
    if (!previous) return;
    if (Date.now() - previous.at > FALSE_POSITIVE_WINDOW_MS) {
      this.lastHandled.delete(turn.conversationId);
      return;
    }
    const normalized = normalizeText(turn.text);
    if (normalized === previous.normalized) {
      this.metrics.count(`false-positive-signal:${previous.intent}:repeated`);
      return;
    }
    const asksHuman = this.resolver.classify(turn.text, { openFlow: false });
    if (asksHuman.decided && asksHuman.intent.id === 'human_request') {
      this.metrics.count(
        `false-positive-signal:${previous.intent}:asked-human`,
      );
    }
  }
}
