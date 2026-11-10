/**
 * Estado "la imagen no se pudo analizar". No detiene la conversación: la
 * imagen sigue llegando al panel como siempre y el bot continúa. Queda en el
 * contexto de la conversación y el panel lo recibe como una advertencia.
 */
export const IMAGE_WARNING_KEY = 'imageAnalysisWarning';
export const IMAGE_NOT_ANALYZED = 'IMAGE_NOT_ANALYZED';

export type ImageNotAnalyzedReason =
  | 'NOT_RUN'
  | 'PROVIDER_UNAVAILABLE'
  | 'ANALYSIS_ERROR'
  | 'SPECIALIST_ERROR';

export interface ConversationWarning {
  code: typeof IMAGE_NOT_ANALYZED;
  reason: ImageNotAnalyzedReason;
  since: string;
}

const REASONS: readonly string[] = [
  'NOT_RUN',
  'PROVIDER_UNAVAILABLE',
  'ANALYSIS_ERROR',
  'SPECIALIST_ERROR',
];

/** Advertencias para el panel, derivadas del contexto. Tolera datos corruptos. */
export function warningsOf(context: unknown): ConversationWarning[] {
  const raw = (context as Record<string, unknown> | null | undefined)?.[
    IMAGE_WARNING_KEY
  ] as { reason?: unknown; at?: unknown } | null | undefined;
  if (!raw || typeof raw !== 'object') return [];
  if (typeof raw.reason !== 'string' || !REASONS.includes(raw.reason)) {
    return [];
  }
  return [
    {
      code: IMAGE_NOT_ANALYZED,
      reason: raw.reason as ImageNotAnalyzedReason,
      since: typeof raw.at === 'string' ? raw.at : '',
    },
  ];
}
