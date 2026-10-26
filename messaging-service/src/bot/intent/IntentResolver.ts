import { Injectable, Optional } from '@nestjs/common';
import { IntentRecord, RULE_KEY_PREFIX } from './intent-types';
import { isScheduledNow } from './schedule';
import { normalizeText, stripLeadingGreeting, tokenCount } from './normalize';

export type UndecidedReason =
  | 'empty'
  | 'multi-message'
  | 'no-match'
  | 'multiple-intents'
  | 'denied'
  | 'negation-or-doubt'
  | 'question'
  | 'open-flow'
  | 'too-long'
  | 'out-of-schedule'
  | 'low-confidence';

export type Classification =
  | {
      decided: true;
      intent: IntentRecord;
      confidence: number;
      normalized: string;
      entity?: string;
    }
  | { decided: false; reason: UndecidedReason; candidate?: string };

export interface ClassifyContext {
  openFlow: boolean;
  timeZone: string;
  now?: Date;
}

export interface CompiledIntent {
  record: IntentRecord;
  patterns: RegExp[];
  deny: RegExp[];
}

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

const NEGATION = /\b(?:no|nunca|ni|tampoco)\b/;
const DOUBT = /\b(?:tal vez|quizas|no se|creo que|pero|aunque|mejor)\b/;

export function compileIntent(record: IntentRecord): CompiledIntent {
  return {
    record,
    patterns: record.patterns.map((p) => new RegExp(p)),
    deny: record.denyPatterns.map((p) => new RegExp(p)),
  };
}

/**
 * Clasificador determinístico sobre las intenciones del bot (datos, no
 * código): normaliza y compara con sus patrones. Ante la duda NO decide: un
 * falso negativo (va a la IA) es preferible a un falso positivo (plantilla
 * equivocada).
 */
@Injectable()
export class IntentResolver {
  constructor(
    @Optional()
    private readonly threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
  ) {}

  classify(
    raw: string,
    context: ClassifyContext,
    intents: CompiledIntent[],
  ): Classification {
    const text = raw.trim();
    if (text === '') return { decided: false, reason: 'empty' };
    if (/\n/.test(text)) return { decided: false, reason: 'multi-message' };

    const normalized = normalizeText(text);
    if (normalized === '') return { decided: false, reason: 'empty' };

    const now = context.now ?? new Date();
    const live = intents.filter(
      (i) =>
        !i.record.key.startsWith(RULE_KEY_PREFIX) &&
        isScheduledNow(i.record.schedule, now, context.timeZone),
    );

    let subject = normalized;
    let matches = this.match(live, subject);
    if (matches.length === 0) {
      const rest = stripLeadingGreeting(normalized);
      if (rest) {
        subject = rest;
        matches = this.match(live, subject);
      }
    }
    if (matches.length === 0) return { decided: false, reason: 'no-match' };

    const alive = matches.filter(
      (m) => !m.intent.deny.some((deny) => deny.test(subject)),
    );
    if (alive.length === 0) {
      return {
        decided: false,
        reason: 'denied',
        candidate: matches[0].intent.record.key,
      };
    }
    matches = alive.length > 1 ? this.resolveOverlap(alive) : alive;
    if (matches.length > 1) {
      return { decided: false, reason: 'multiple-intents' };
    }

    const { intent, entity } = matches[0];
    const record = intent.record;
    const candidate = record.key;
    const tokens = tokenCount(subject);

    if (tokens > record.maxTokens) {
      return { decided: false, reason: 'too-long', candidate };
    }
    if (DOUBT.test(subject) || (!record.negationOk && NEGATION.test(subject))) {
      return { decided: false, reason: 'negation-or-doubt', candidate };
    }
    if (!record.allowsQuestion && /[?¿]/.test(text)) {
      return { decided: false, reason: 'question', candidate };
    }
    if (context.openFlow && record.respectsOpenFlow) {
      return { decided: false, reason: 'open-flow', candidate };
    }

    const confidence =
      record.fixedConfidence ??
      Math.max(0.6, 0.95 - 0.03 * Math.max(0, tokens - 4));
    if (confidence < this.threshold) {
      return { decided: false, reason: 'low-confidence', candidate };
    }
    return { decided: true, intent: record, confidence, normalized, entity };
  }

  /**
   * Una intención amplia (LLM_SLIM, p. ej. "agendar") cede ante una
   * específica que también coincide. Entre varias específicas no se decide;
   * entre varias amplias gana la de menor prioridad solo si es única.
   */
  private resolveOverlap<T extends { intent: CompiledIntent }>(
    matches: T[],
  ): T[] {
    const specific = matches.filter(
      (m) => m.intent.record.handler !== 'LLM_SLIM',
    );
    if (specific.length === 1) return specific;
    if (specific.length > 1) return matches;
    const sorted = [...matches].sort(
      (a, b) => a.intent.record.priority - b.intent.record.priority,
    );
    return sorted[0].intent.record.priority < sorted[1].intent.record.priority
      ? [sorted[0]]
      : matches;
  }

  private match(intents: CompiledIntent[], subject: string) {
    const found: Array<{ intent: CompiledIntent; entity?: string }> = [];
    for (const intent of intents) {
      for (const pattern of intent.patterns) {
        const result = pattern.exec(subject);
        if (result) {
          found.push({ intent, entity: result.groups?.entity?.trim() });
          break;
        }
      }
    }
    return found;
  }
}
