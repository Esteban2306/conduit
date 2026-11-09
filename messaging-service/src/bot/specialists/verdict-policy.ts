import {
  ExtractedFields,
  MAX_HUMAN_SUMMARY,
  RulesDocument,
  Verdict,
} from './contracts';
import { EvaluationContext, evaluateRules } from './rule-evaluator';

export interface PolicyOutcome {
  verdict: Verdict;
  reasonCodes: string[];
}

export interface PolicyInput {
  fields: ExtractedFields;
  isExpectedDocument?: boolean;
}

export function decideVerdict(
  input: PolicyInput,
  rules: RulesDocument,
  context: EvaluationContext,
): PolicyOutcome {
  if (input.isExpectedDocument === false) {
    return {
      verdict: 'NOT_APPLICABLE',
      reasonCodes: ['NOT_EXPECTED_DOCUMENT'],
    };
  }

  switch (input.fields.legibility) {
    case 'UNREADABLE':
      return { verdict: 'UNREADABLE', reasonCodes: ['IMAGE_UNREADABLE'] };
    case 'PARTIAL':
      return { verdict: 'NEEDS_REVIEW', reasonCodes: ['LEGIBILITY_PARTIAL'] };
    case 'CLEAR': {
      const evaluation = evaluateRules(input.fields, rules, context);
      if (evaluation.verdict === 'VALID' && context.requiredUnavailable) {
        return {
          verdict: 'NEEDS_REVIEW',
          reasonCodes: ['GROUNDING_UNAVAILABLE'],
        };
      }
      return {
        verdict: evaluation.verdict,
        reasonCodes: evaluation.reasonCodes,
      };
    }
    default:
      return { verdict: 'NEEDS_REVIEW', reasonCodes: ['LEGIBILITY_UNKNOWN'] };
  }
}

const SUMMARIES: Record<string, string> = {
  IMAGE_UNREADABLE: 'La imagen no se puede leer.',
  LEGIBILITY_PARTIAL: 'La imagen se lee solo en parte; requiere revisión.',
  LEGIBILITY_UNKNOWN:
    'No se pudo determinar la legibilidad; requiere revisión.',
  NO_RULES_CONFIGURED: 'Imagen legible y sin reglas configuradas.',
  RULES_PASSED: 'Cumple todas las reglas configuradas.',
  NOT_EXPECTED_DOCUMENT: 'La imagen no es el tipo de documento esperado.',
  GROUNDING_UNAVAILABLE:
    'No se pudo consultar un dato de referencia; requiere revisión.',
  RULE_OPERAND_INVALID:
    'Una regla tiene un valor de referencia inválido; requiere revisión.',
  OUTPUT_NOT_JSON: 'El modelo no devolvió un resultado interpretable.',
  OUTPUT_INVALID: 'El resultado del modelo no cumple el formato esperado.',
  TIMEOUT: 'El análisis excedió el tiempo máximo.',
  NO_MODEL: 'El especialista no tiene un modelo disponible.',
  PROVIDER_ERROR: 'El proveedor de IA falló.',
  RULES_INVALID: 'Las reglas del especialista no son válidas.',
  CONTEXT_SOURCES_INVALID:
    'Las fuentes de contexto del especialista no son válidas.',
  INTERNAL_ERROR: 'Ocurrió un error interno al analizar.',
};

const FALLBACK_SUMMARY = 'Resultado sin descripción.';

const FIELD_LABELS: Record<string, string> = {
  AMOUNT: 'monto',
  CURRENCY: 'moneda',
  DATE: 'fecha',
  REFERENCE: 'referencia',
  RECIPIENT: 'destinatario',
  LEGIBILITY: 'legibilidad',
};

function describe(code: string): string | undefined {
  if (SUMMARIES[code]) return SUMMARIES[code];
  const missing = /^([A-Z]+)_MISSING$/.exec(code);
  if (missing && FIELD_LABELS[missing[1]]) {
    return `No se pudo leer el dato "${FIELD_LABELS[missing[1]]}"; requiere revisión.`;
  }
  const failed =
    /^([A-Z]+)_(GTE|LTE|EQ|WITHIN_DAYS|CONTAINS|FUZZY)_FAILED$/.exec(code);
  if (failed && FIELD_LABELS[failed[1]]) {
    return `El dato "${FIELD_LABELS[failed[1]]}" no cumple la regla configurada.`;
  }
  return undefined;
}

export function summarize(reasonCodes: string[]): string {
  const first = reasonCodes[0];
  const text = (first && describe(first)) || FALLBACK_SUMMARY;
  return text.slice(0, MAX_HUMAN_SUMMARY);
}
