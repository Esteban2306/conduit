export type DisconnectKind =
  | 'LOGGED_OUT'
  | 'REPLACED'
  | 'FORBIDDEN'
  | 'OUTDATED_VERSION'
  | 'RESTART'
  | 'NETWORK'
  | 'UNAVAILABLE'
  | 'PROTOCOL';

export interface DisconnectInfo {
  kind: DisconnectKind;
  code: number | undefined;
  detail: string;
}

interface BoomLike {
  message?: unknown;
  output?: { statusCode?: unknown };
}

export const FLAP_WINDOW_MS = 10 * 60_000;
export const FLAP_THRESHOLD = 4;
export const FORBIDDEN_CONFIRM_WINDOW_MS = 15 * 60_000;

/**
 * Qué significa realmente un cierre de WhatsApp. Baileys usa 500 como valor
 * por defecto de cualquier error de flujo sin código conocido, y 408/428 son
 * caídas de red: ninguno de ellos es una señal de bloqueo. Solo 401, 440 y 403
 * hablan de la cuenta.
 */
export function classifyDisconnect(error: unknown): DisconnectInfo {
  const boom = (error ?? {}) as BoomLike;
  const raw = boom.output?.statusCode;
  const code = typeof raw === 'number' ? raw : undefined;
  const detail = typeof boom.message === 'string' ? boom.message : '';
  const conflict = /\(conflict\)/i.test(detail);

  if (conflict || code === 440) return { kind: 'REPLACED', code, detail };
  switch (code) {
    case 401:
      return { kind: 'LOGGED_OUT', code, detail };
    case 403:
      return { kind: 'FORBIDDEN', code, detail };
    case 405:
      return { kind: 'OUTDATED_VERSION', code, detail };
    case 515:
      return { kind: 'RESTART', code, detail };
    case 408:
    case 428:
      return { kind: 'NETWORK', code, detail };
    case 503:
      return { kind: 'UNAVAILABLE', code, detail };
    default:
      return { kind: 'PROTOCOL', code, detail };
  }
}

/** Cierres que cuentan para detectar una conexión que no se sostiene (no el 515, que es normal tras emparejar). */
export function countsAsFlap(kind: DisconnectKind): boolean {
  return kind !== 'RESTART';
}

/** Ventana deslizante de cierres por conexión. */
export class FlapDetector {
  private readonly events = new Map<string, number[]>();

  record(connectionId: string, now: number = Date.now()): number {
    const recent = (this.events.get(connectionId) ?? []).filter(
      (t) => now - t < FLAP_WINDOW_MS,
    );
    recent.push(now);
    this.events.set(connectionId, recent);
    return recent.length;
  }

  clear(connectionId: string): void {
    this.events.delete(connectionId);
  }
}
