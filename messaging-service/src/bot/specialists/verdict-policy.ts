import {
  Legibility,
  MAX_HUMAN_SUMMARY,
  OutputSchemaDocument,
  RulesDocument,
  Variables,
  Verdict,
} from './contracts';
import { EvaluationContext, evaluateRules } from './rule-evaluator';

export interface PolicyOutcome {
  verdict: Verdict;
  reasonCodes: string[];
}

export interface PolicyInput {
  variables: Variables;
  legibility?: Legibility;
  isExpectedDocument?: boolean;
}

export function decideVerdict(
  input: PolicyInput,
  schema: OutputSchemaDocument,
  rules: RulesDocument,
  context: EvaluationContext,
): PolicyOutcome {
  if (input.isExpectedDocument === false) {
    return {
      verdict: 'NOT_APPLICABLE',
      reasonCodes: ['NOT_EXPECTED_DOCUMENT'],
    };
  }

  switch (input.legibility) {
    case 'UNREADABLE':
      return { verdict: 'UNREADABLE', reasonCodes: ['IMAGE_UNREADABLE'] };
    case 'PARTIAL':
      return { verdict: 'NEEDS_REVIEW', reasonCodes: ['LEGIBILITY_PARTIAL'] };
    case 'CLEAR': {
      const evaluation = evaluateRules(input.variables, schema, rules, context);
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
  OUTPUT_SCHEMA_INVALID:
    'Las variables de salida del especialista no son válidas.',
  CONTEXT_SOURCES_INVALID:
    'Las fuentes de contexto del especialista no son válidas.',
  INTERNAL_ERROR: 'Ocurrió un error interno al analizar.',
};

const FALLBACK_SUMMARY = 'Resultado sin descripción.';

const MISSING_SUFFIX = '_MISSING';
const FAILED_SUFFIX =
  /_(GTE|LTE|EQ|IN|WITHIN_DAYS|WITHIN|CONTAINS|FUZZY)_FAILED$/;

function labelsOf(
  schema: OutputSchemaDocument | undefined,
): Map<string, string> {
  const labels = new Map<string, string>();
  for (const variable of schema?.variables ?? []) {
    labels.set(variable.name.toUpperCase(), variable.label ?? variable.name);
  }
  return labels;
}

function describe(
  code: string,
  labels: Map<string, string>,
): string | undefined {
  if (SUMMARIES[code]) return SUMMARIES[code];
  if (code.endsWith(MISSING_SUFFIX)) {
    const label = labels.get(code.slice(0, -MISSING_SUFFIX.length));
    if (label) return `No se pudo leer el dato "${label}"; requiere revisión.`;
  }
  const failed = FAILED_SUFFIX.exec(code);
  if (failed) {
    const label = labels.get(code.slice(0, failed.index));
    if (label) return `El dato "${label}" no cumple la regla configurada.`;
  }
  return undefined;
}

export function summarize(
  reasonCodes: string[],
  schema?: OutputSchemaDocument,
): string {
  const first = reasonCodes[0];
  const text = (first && describe(first, labelsOf(schema))) || FALLBACK_SUMMARY;
  return text.slice(0, MAX_HUMAN_SUMMARY);
}
