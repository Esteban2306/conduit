import { createHmac, timingSafeEqual } from 'crypto';

export const HMAC_ALGORITHM = 'sha256';
export const HMAC_SIGNATURE_PREFIX = 'sha256=';

export function computeHmacSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
): string {
  const payload = `${timestamp}.${rawBody}`;
  const digest = createHmac(HMAC_ALGORITHM, secret)
    .update(payload, 'utf-8')
    .digest('hex');

  return `${HMAC_SIGNATURE_PREFIX}${digest}`;
}

export function safeCompareSignatures(
  expected: string,
  received: string,
): boolean {
  const expectedBuf = Buffer.from(expected, 'utf-8');
  const receivedBuf = Buffer.from(received, 'utf-8');

  if (expectedBuf.length !== receivedBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }

  return timingSafeEqual(expectedBuf, receivedBuf);
}

export function isTimestampFresh(
  timestampSeconds: number,
  windowSeconds: number,
  nowMs = Date.now(),
): boolean {
  if (!Number.isFinite(timestampSeconds)) return false;
  const nowSeconds = Math.floor(nowMs / 1000);
  const diff = Math.abs(nowSeconds - timestampSeconds);
  return diff <= windowSeconds;
}
