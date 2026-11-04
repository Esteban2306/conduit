export const OUTBOX_TTL_MS = 30 * 60_000;
export const OUTBOX_MAX_ATTEMPTS = 6;
export const OUTBOX_BACKOFF_MS = [5_000, 15_000, 45_000, 120_000, 300_000];
export const NOT_CONNECTED_RETRY_MS = 5_000;
export const OVERLIMIT_RETRY_MS = 120_000;
export const STALE_SENDING_MS = 2 * 60_000;

export interface SendOutcome {
  success: boolean;
  retryable?: boolean;
  errorCode?: string;
}

export type Verdict =
  | { action: 'sent' }
  | { action: 'wait'; delayMs: number }
  | { action: 'retry'; delayMs: number }
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
