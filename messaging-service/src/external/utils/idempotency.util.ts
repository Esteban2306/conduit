import { createHash } from 'crypto';

export function computePayloadHash(
  eventType: string,
  payload: Record<string, any>,
): string {
  const normalized = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash('sha256')
    .update(`${eventType}:${normalized}`)
    .digest('hex');
}
