import { z } from 'zod';
import {
  STABLE_KEY_MAX_LENGTH,
  STABLE_KEY_MESSAGE,
  STABLE_KEY_PATTERN,
} from 'src/shared/stable-key';

const stableKey = z
  .string()
  .min(2)
  .max(STABLE_KEY_MAX_LENGTH)
  .regex(STABLE_KEY_PATTERN, STABLE_KEY_MESSAGE);

export const specialistKeySchema = stableKey;
export const capabilitySchema = stableKey;

export const groundingKeySchema = z
  .string()
  .regex(
    /^[a-z][a-zA-Z0-9_]{0,39}$/,
    'La clave de contexto debe empezar por minúscula y usar solo letras, números y guion bajo (máx. 40).',
  );

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function safeText(max: number) {
  return z
    .string()
    .max(max)
    .refine((value) => !hasControlChars(value), {
      message:
        'El texto no puede contener saltos de línea ni caracteres de control.',
    });
}
