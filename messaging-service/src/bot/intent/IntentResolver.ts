import { Injectable, Optional } from '@nestjs/common';
import { DEFAULT_INTENTS, IntentDefinition, IntentId } from './intent-catalog';
import { normalizeText, tokenCount } from './normalize';

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
  | 'low-confidence';

export type Classification =
  | {
      decided: true;
      intent: IntentDefinition;
      confidence: number;
      normalized: string;
    }
  | {
      decided: false;
      reason: UndecidedReason;
      candidate?: IntentId;
    };

export interface ClassifyContext {
  openFlow: boolean;
}

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8;

const NEGATION = /\b(?:no|nunca|ni|tampoco)\b/;
const DOUBT = /\b(?:tal vez|quizas|no se|creo que|pero|aunque|mejor)\b/;

/**
 * Clasificador determinístico: normaliza y compara con la tabla de
 * intenciones. Ante la duda NO decide (un falso negativo, que va a la IA,
 * es preferible a un falso positivo con la plantilla equivocada).
 */
@Injectable()
export class IntentResolver {
  private readonly compiled = new Map<
    IntentId,
    { patterns: RegExp[]; deny: RegExp[] }
  >();

  constructor(
    @Optional() private readonly catalog: IntentDefinition[] = DEFAULT_INTENTS,
    @Optional()
    private readonly threshold: number = DEFAULT_CONFIDENCE_THRESHOLD,
  ) {
    for (const intent of catalog) {
      this.compiled.set(intent.id, {
        patterns: intent.patterns.map((p) => new RegExp(p)),
        deny: intent.deny.map((p) => new RegExp(p)),
      });
    }
  }

  definition(id: IntentId): IntentDefinition | undefined {
    return this.catalog.find((i) => i.id === id);
  }

  classify(raw: string, context: ClassifyContext): Classification {
    const text = raw.trim();
    if (text === '') return { decided: false, reason: 'empty' };
    if (/\n/.test(text)) return { decided: false, reason: 'multi-message' };

    const normalized = normalizeText(text);
    if (normalized === '') return { decided: false, reason: 'empty' };
    const tokens = tokenCount(normalized);

    const matches = this.catalog.filter((intent) =>
      this.compiled
        .get(intent.id)!
        .patterns.some((pattern) => pattern.test(normalized)),
    );
    if (matches.length === 0) return { decided: false, reason: 'no-match' };
    if (matches.length > 1) {
      return { decided: false, reason: 'multiple-intents' };
    }

    const intent = matches[0];
    const compiled = this.compiled.get(intent.id)!;
    const candidate = intent.id;

    if (tokens > intent.maxTokens) {
      return { decided: false, reason: 'too-long', candidate };
    }
    if (compiled.deny.some((deny) => deny.test(normalized))) {
      return { decided: false, reason: 'denied', candidate };
    }
    if (
      DOUBT.test(normalized) ||
      (!intent.negationOk && NEGATION.test(normalized))
    ) {
      return { decided: false, reason: 'negation-or-doubt', candidate };
    }
    if (!intent.allowsQuestion && /[?¿]/.test(text)) {
      return { decided: false, reason: 'question', candidate };
    }
    if (context.openFlow && intent.respectsOpenFlow) {
      return { decided: false, reason: 'open-flow', candidate };
    }

    const confidence =
      intent.fixedConfidence ??
      Math.max(0.6, 0.95 - 0.03 * Math.max(0, tokens - 4));
    if (confidence < this.threshold) {
      return { decided: false, reason: 'low-confidence', candidate };
    }
    return { decided: true, intent, confidence, normalized };
  }
}
