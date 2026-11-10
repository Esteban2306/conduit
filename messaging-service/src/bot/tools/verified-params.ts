import { z } from 'zod';
import { MAX_VARIABLE_NAME } from '../specialists/contracts';

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
export const MAX_VERIFIED_PARAMS = 12;
const VARIABLE_NAME_PATTERN = new RegExp(
  `^[a-z][a-z0-9_]{0,${MAX_VARIABLE_NAME - 1}}$`,
);
export const PARAM_PATH_PATTERN =
  /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Ruta del parámetro -> nombre de variable verificada (de la capacidad de la herramienta). */
export const verifiedParamsSchema = z
  .record(
    z
      .string()
      .max(120)
      .regex(PARAM_PATH_PATTERN)
      .refine((path) => !path.split('.').some((p) => FORBIDDEN.has(p)), {
        message: 'Ruta no permitida.',
      }),
    z.string().regex(VARIABLE_NAME_PATTERN),
  )
  .refine((map) => Object.keys(map).length <= MAX_VERIFIED_PARAMS, {
    message: `Máximo ${MAX_VERIFIED_PARAMS} parámetros verificados.`,
  });

export type VerifiedParams = z.infer<typeof verifiedParamsSchema>;

/** Lectura tolerante: un valor corrupto en la base equivale a no declarar nada. */
export function readVerifiedParams(raw: unknown): VerifiedParams {
  const parsed = verifiedParamsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/** Dos rutas chocan si son iguales o una cuelga de la otra. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}
