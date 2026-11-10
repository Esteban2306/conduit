import { createHash } from 'crypto';
import { OutputSchemaDocument, Variables, findVariable } from './contracts';

const FINGERPRINT_VERSION = 'v2';
const NUMBER_DECIMALS = 6;

function normalizeIdentity(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export function variablesFingerprint(
  schema: OutputSchemaDocument,
  variables: Variables,
): string | null {
  if (schema.uniqueBy.length === 0) return null;

  const parts: string[] = [FINGERPRINT_VERSION];
  for (const name of schema.uniqueBy) {
    const variable = findVariable(schema, name);
    const value = variables[name];
    if (!variable || value === undefined || value === null) return null;

    let normalized: string;
    switch (variable.type) {
      case 'number':
        if (typeof value !== 'number') return null;
        normalized = value.toFixed(NUMBER_DECIMALS);
        break;
      case 'string': {
        if (typeof value !== 'string') return null;
        normalized = normalizeIdentity(value);
        if (normalized.length < (variable.identityMinLength ?? 1)) return null;
        break;
      }
      default:
        normalized = String(value);
    }
    parts.push(`${name}=${normalized}`);
  }
  return createHash('sha256').update(parts.join('|')).digest('hex');
}
