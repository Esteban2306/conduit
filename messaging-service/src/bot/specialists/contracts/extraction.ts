import { z } from 'zod';
import { OutputSchemaDocument, Variable } from './output-schema';
import { safeText } from './keys';

export function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export const LEGIBILITY_LEVELS = ['CLEAR', 'PARTIAL', 'UNREADABLE'] as const;
export type Legibility = (typeof LEGIBILITY_LEVELS)[number];

export type VariableValue = string | number | boolean;
export type Variables = Record<string, VariableValue | null>;

export const DEFAULT_NUMBER_BOUND = 1e12;
export const DEFAULT_STRING_LENGTH = 120;

export function variableValueSchema(variable: Variable): z.ZodType {
  switch (variable.type) {
    case 'number':
      return z
        .number()
        .finite()
        .min(variable.min ?? -DEFAULT_NUMBER_BOUND)
        .max(variable.max ?? DEFAULT_NUMBER_BOUND);
    case 'string':
      return safeText(variable.maxLength ?? DEFAULT_STRING_LENGTH);
    case 'boolean':
      return z.boolean();
    case 'date':
      return z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .refine(isRealCalendarDate, { message: 'Fecha inválida' });
    case 'enum':
      return z.enum(variable.values as [string, ...string[]]);
  }
}

export function variablesSchemaFor(
  schema: OutputSchemaDocument,
): z.ZodType<Variables> {
  const shape: Record<string, z.ZodType> = {};
  for (const variable of schema.variables) {
    shape[variable.name] = variableValueSchema(variable).nullable().optional();
  }
  return z.object(shape).strict().partial() as unknown as z.ZodType<Variables>;
}

export const EXTRACTION_VERSION = 2;

export interface ExtractionOutput {
  version: typeof EXTRACTION_VERSION;
  confidence?: number;
  isExpectedDocument?: boolean;
  legibility?: Legibility;
  variables: Variables;
}

export function extractionSchemaFor(
  schema: OutputSchemaDocument,
): z.ZodType<ExtractionOutput> {
  return z
    .object({
      version: z.literal(EXTRACTION_VERSION),
      confidence: z.number().min(0).max(1).optional(),
      isExpectedDocument: z.boolean().optional(),
      legibility: z.enum(LEGIBILITY_LEVELS).optional(),
      variables: variablesSchemaFor(schema),
    })
    .strict();
}

export function sanitizeVariables(
  raw: unknown,
  schema: OutputSchemaDocument,
): Variables {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const clean: Variables = {};
  for (const variable of schema.variables) {
    if (!Object.prototype.hasOwnProperty.call(source, variable.name)) continue;
    const value = source[variable.name];
    if (value === null) {
      clean[variable.name] = null;
      continue;
    }
    const parsed = variableValueSchema(variable).safeParse(value);
    if (parsed.success) clean[variable.name] = parsed.data as VariableValue;
  }
  return clean;
}

export const MAX_RECORD_VARIABLES = 12;
const RECORD_KEY = /^[a-z][a-z0-9_]{0,19}$/;

export const variablesRecordSchema = z
  .record(
    z.string().regex(RECORD_KEY),
    z.union([z.string().max(200), z.number().finite(), z.boolean(), z.null()]),
  )
  .refine((record) => Object.keys(record).length <= MAX_RECORD_VARIABLES, {
    message: 'Demasiadas variables',
  });
