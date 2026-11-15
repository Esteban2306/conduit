export const OUTBOX_TTL_MS = 30 * 60_000;
export const OUTBOX_MAX_ATTEMPTS = 6;
export const OUTBOX_BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000];
export const NOT_CONNECTED_RETRY_MS = 5_000;
export const OVERLIMIT_RETRY_MS = 120_000;
export const STALE_SENDING_MS = 2 * 60_000;
/** Cada cuánto se revisa si el cliente dejó de escribir antes de enviarle la respuesta. */
export const TYPING_HOLD_RETRY_MS = 5_000;
/** Tope de espera por un cliente que sigue escribiendo; pasado ese tiempo la respuesta sale. */
export const TYPING_HOLD_MAX_MS = 60_000;

export interface SendOutcome {
  success: boolean;
  retryable?: boolean;
  errorCode?: string;
}

export type Verdict =
  | { action: 'sent' }
  | { action: 'wait'; delayMs: number }
  | { action: 'retry'; delayMs: number }
  | { action: 'hold'; delayMs: number }
  | { action: 'cancel' }
  | { action: 'fail' };

export function backoffMs(attempts: number): number {
  return OUTBOX_BACKOFF_MS[
    Math.min(Math.max(attempts - 1, 0), OUTBOX_BACKOFF_MS.length - 1)
  ];
}

/**
 * Qué hacer con un envío según su resultado. Con el canal desconectado se
 * espera sin gastar intentos (no es culpa del mensaje); un fallo transitorio
 * reintenta con backoff hasta agotar intentos; el resto es definitivo.
 */
export function verdictFor(
  outcome: SendOutcome,
  attemptsMade: number,
): Verdict {
  if (outcome.success) return { action: 'sent' };
  // El cliente volvió a escribir: no es un fallo y no gasta intentos.
  if (outcome.errorCode === 'SUPERSEDED') return { action: 'cancel' };
  if (outcome.errorCode === 'CLIENT_TYPING') {
    return { action: 'hold', delayMs: TYPING_HOLD_RETRY_MS };
  }
  if (outcome.errorCode === 'WHATSAPP_NOT_CONNECTED') {
    return { action: 'wait', delayMs: NOT_CONNECTED_RETRY_MS };
  }
  if (outcome.retryable && attemptsMade < OUTBOX_MAX_ATTEMPTS) {
    const delayMs = backoffMs(attemptsMade);
    return {
      action: 'retry',
      delayMs:
        outcome.errorCode === 'RATE_OVERLIMIT'
          ? Math.max(delayMs, OVERLIMIT_RETRY_MS)
          : delayMs,
    };
  }
  return { action: 'fail' };
}
