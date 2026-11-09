import {
  ExtractedFields,
  MAX_HUMAN_SUMMARY,
  RulesDocument,
  Verdict,
} from './contracts';

export interface PolicyOutcome {
  verdict: Verdict;
  reasonCodes: string[];
}

export function decideVerdict(
  fields: ExtractedFields,
  rules: RulesDocument,
): PolicyOutcome {
  switch (fields.legibility) {
    case 'UNREADABLE':
      return { verdict: 'UNREADABLE', reasonCodes: ['IMAGE_UNREADABLE'] };
    case 'PARTIAL':
      return { verdict: 'NEEDS_REVIEW', reasonCodes: ['LEGIBILITY_PARTIAL'] };
    case 'CLEAR':
      return rules.rules.length > 0
        ? { verdict: 'NEEDS_REVIEW', reasonCodes: ['RULES_NOT_EVALUATED'] }
        : { verdict: 'VALID', reasonCodes: ['NO_RULES_CONFIGURED'] };
    default:
      return { verdict: 'NEEDS_REVIEW', reasonCodes: ['LEGIBILITY_UNKNOWN'] };
  }
}

const SUMMARIES: Record<string, string> = {
  IMAGE_UNREADABLE: 'La imagen no se puede leer.',
  LEGIBILITY_PARTIAL: 'La imagen se lee solo en parte; requiere revisión.',
  LEGIBILITY_UNKNOWN:
    'No se pudo determinar la legibilidad; requiere revisión.',
  RULES_NOT_EVALUATED:
    'Hay reglas configuradas que aún no se evalúan; requiere revisión.',
  NO_RULES_CONFIGURED: 'Imagen legible y sin reglas configuradas.',
  OUTPUT_NOT_JSON: 'El modelo no devolvió un resultado interpretable.',
  OUTPUT_INVALID: 'El resultado del modelo no cumple el formato esperado.',
  TIMEOUT: 'El análisis excedió el tiempo máximo.',
  NO_MODEL: 'El especialista no tiene un modelo disponible.',
  PROVIDER_ERROR: 'El proveedor de IA falló.',
  RULES_INVALID: 'Las reglas del especialista no son válidas.',
  INTERNAL_ERROR: 'Ocurrió un error interno al analizar.',
};

const FALLBACK_SUMMARY = 'Resultado sin descripción.';

export function summarize(reasonCodes: string[]): string {
  const first = reasonCodes[0];
  const text = (first && SUMMARIES[first]) || FALLBACK_SUMMARY;
  return text.slice(0, MAX_HUMAN_SUMMARY);
}
