import { createHash } from 'crypto';
import { ExtractedFields } from './contracts';

const MIN_REFERENCE_LENGTH = 5;
const FINGERPRINT_VERSION = 'v1';

export function fieldsFingerprint(fields: ExtractedFields): string | null {
  const { reference, amount, date, currency } = fields;
  if (
    typeof reference !== 'string' ||
    typeof amount !== 'number' ||
    typeof date !== 'string'
  ) {
    return null;
  }

  const normalizedReference = reference.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalizedReference.length < MIN_REFERENCE_LENGTH) return null;

  return createHash('sha256')
    .update(
      [
        FINGERPRINT_VERSION,
        normalizedReference,
        amount.toFixed(2),
        date,
        currency ?? '',
      ].join('|'),
    )
    .digest('hex');
}
