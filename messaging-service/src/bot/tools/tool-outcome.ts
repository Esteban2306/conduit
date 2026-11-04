export type OutcomeKind = 'SUCCESS' | 'EXPECTED' | 'TECHNICAL' | 'PERMISSION';

export interface ClassifiedOutcome {
  kind: OutcomeKind;
  httpStatus: number | null;
  code?: string;
  message?: string;
  nextStep?: string;
  alternatives?: unknown;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Qué clase de resultado fue una llamada a una herramienta:
 * - EXPECTED: el negocio dijo que no (horario ocupado, reserva inexistente,
 *   falta un dato). El modelo lo explica y ofrece opciones; no se escala.
 * - TECHNICAL: la herramienta no pudo responder (red, timeout, 5xx, 408, 429).
 * - PERMISSION: identidad o permiso (401/403): es un problema de configuración.
 *
 * Se deriva del estado HTTP y del cuerpo estructurado del backend (`code`,
 * `message`, `nextStep`, `details.alternatives`), sin interpretar texto.
 */
export function classifyOutcome(
  status: string,
  httpStatus: number | null,
  body: unknown,
): ClassifiedOutcome {
  if (status === 'SUCCESS') return { kind: 'SUCCESS', httpStatus };

  const parsed = record(body);
  const details = record(parsed?.details);
  const extra = {
    ...(typeof parsed?.code === 'string' && { code: parsed.code }),
    ...(typeof parsed?.message === 'string' && { message: parsed.message }),
    ...(typeof parsed?.nextStep === 'string' && { nextStep: parsed.nextStep }),
    ...(details?.alternatives !== undefined && {
      alternatives: details.alternatives,
    }),
  };

  if (httpStatus === 401 || httpStatus === 403) {
    return { kind: 'PERMISSION', httpStatus, ...extra };
  }
  if (
    status === 'TECHNICAL_ERROR' ||
    httpStatus === null ||
    httpStatus === 408 ||
    httpStatus === 429 ||
    httpStatus >= 500
  ) {
    return { kind: 'TECHNICAL', httpStatus, ...extra };
  }
  return { kind: 'EXPECTED', httpStatus, ...extra };
}

export const EXPECTED_FAILURES_BEFORE_OFFER = 3;

export interface FailureStreak {
  code: string;
  count: number;
}

export type FailureStreaks = Record<string, FailureStreak>;

/**
 * Racha de fallos esperados seguidos por herramienta y código: un éxito de
 * la herramienta la reinicia; el mismo código repetido la hace crecer.
 */
export function nextStreaks(
  previous: FailureStreaks,
  tool: string,
  outcome: ClassifiedOutcome,
): { streaks: FailureStreaks; count: number } {
  const streaks = { ...previous };
  if (outcome.kind === 'SUCCESS') {
    delete streaks[tool];
    return { streaks, count: 0 };
  }
  if (outcome.kind !== 'EXPECTED') return { streaks, count: 0 };

  const code = outcome.code ?? 'UNKNOWN';
  const count = streaks[tool]?.code === code ? streaks[tool].count + 1 : 1;
  streaks[tool] = { code, count };
  return { streaks, count };
}

export interface RecordedOutcome {
  tool: string;
  readOnly: boolean;
  outcome: ClassifiedOutcome;
}

/**
 * Último resultado de cada herramienta que quedó sin resolver: una de
 * escritura fallida siempre cuenta; una de lectura deja de contar si una
 * lectura posterior tuvo éxito (el modelo se recuperó).
 */
export function unresolvedFailures(
  calls: RecordedOutcome[],
): RecordedOutcome[] {
  const last = new Map<string, number>();
  calls.forEach((call, index) => last.set(call.tool, index));
  const pending: RecordedOutcome[] = [];
  for (const [, index] of last) {
    const call = calls[index];
    if (call.outcome.kind === 'SUCCESS') continue;
    const recovered =
      call.readOnly &&
      calls
        .slice(index + 1)
        .some((later) => later.readOnly && later.outcome.kind === 'SUCCESS');
    if (!recovered) pending.push(call);
  }
  return pending;
}
