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

function isHostileCodePoint(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0xad ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    (code >= 0xfff9 && code <= 0xfffb) ||
    code === 0xfeff
  );
}

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code !== undefined && isHostileCodePoint(code)) return true;
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
