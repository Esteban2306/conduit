import { z } from 'zod';
import { safeText } from './keys';

export const EXTRACTION_FIELD_NAMES = [
  'amount',
  'currency',
  'date',
  'reference',
  'recipient',
  'legibility',
] as const;

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

export const extractionFieldNameSchema = z.enum(EXTRACTION_FIELD_NAMES);
export type ExtractionFieldName = z.infer<typeof extractionFieldNameSchema>;

export const LEGIBILITY_LEVELS = ['CLEAR', 'PARTIAL', 'UNREADABLE'] as const;

export const extractedFieldsSchema = z
  .object({
    amount: z.number().finite().min(0).max(1e12).nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(isRealCalendarDate, { message: 'Fecha inválida' })
      .nullable(),
    reference: safeText(64).nullable(),
    recipient: safeText(120).nullable(),
    legibility: z.enum(LEGIBILITY_LEVELS),
  })
  .partial()
  .strict();
export type ExtractedFields = z.infer<typeof extractedFieldsSchema>;

export const EXTRACTION_VERSION = 1;

export const extractionOutputSchema = z
  .object({
    version: z.literal(EXTRACTION_VERSION),
    confidence: z.number().min(0).max(1).optional(),
    isExpectedDocument: z.boolean().optional(),
    fields: extractedFieldsSchema,
  })
  .strict();
export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;
