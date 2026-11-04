import { createHash } from 'crypto';

/** Serialización con claves ordenadas en todos los niveles. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

/**
 * Huella del evento para deduplicar cuando el integrador no envía
 * `X-Conduit-Event-Id`. Incluye los campos anidados: antes solo se
 * consideraban las claves de primer nivel y dos eventos distintos con el
 * mismo nivel superior se descartaban como duplicados.
 */
export function computePayloadHash(
  eventType: string,
  payload: Record<string, any>,
): string {
  const normalized = JSON.stringify(canonicalize(payload));
  return createHash('sha256')
    .update(`${eventType}:${normalized}`)
    .digest('hex');
}
