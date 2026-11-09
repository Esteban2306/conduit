import { z } from 'zod';
import {
  MAX_PROMPT_LENGTH,
  capabilitySchema,
  contextSourcesDocumentSchema,
  declaredOutputSchemaSchema,
  VERDICTS,
  reasonCodeSchema,
  safeText,
  rulesDocumentSchema,
} from '../contracts';

export const VERDICT_VALUES = VERDICTS;
export const MODE_VALUES = ['SHADOW', 'ACTIVE'] as const;

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const MAX_RANGE_DAYS = 366;

const id = z.string().min(1).max(64);
const isoDate = z.string().datetime({ offset: true });

export const listVerificationsSchema = z
  .object({
    specialistId: id.optional(),
    botConfigId: id.optional(),
    conversationId: z.string().min(1).max(128).optional(),
    capability: capabilitySchema.optional(),
    verdict: z.enum(VERDICT_VALUES).optional(),
    mode: z.enum(MODE_VALUES).optional(),
    reasonCode: reasonCodeSchema.optional(),
    pendingReview: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.from ||
      !value.to ||
      new Date(value.from).getTime() <= new Date(value.to).getTime(),
    { message: '"from" no puede ser posterior a "to"' },
  )
  .refine(
    (value) =>
      !value.from ||
      !value.to ||
      new Date(value.to).getTime() - new Date(value.from).getTime() <=
        MAX_RANGE_DAYS * 86_400_000,
    { message: `El rango no puede superar ${MAX_RANGE_DAYS} días` },
  );
export type ListVerificationsQuery = z.infer<typeof listVerificationsSchema>;

export const dryRunDraftSchema = z
  .object({
    promptTemplate: z.string().min(1).max(MAX_PROMPT_LENGTH).optional(),
    outputSchema: declaredOutputSchemaSchema.optional(),
    rules: rulesDocumentSchema.optional(),
    contextSources: contextSourcesDocumentSchema.optional(),
  })
  .strict();
export type DryRunDraft = z.infer<typeof dryRunDraftSchema>;

export function encodeCursor(createdAt: Date, rowId: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${rowId}`).toString(
    'base64url',
  );
}

export function decodeCursor(
  cursor: string,
): { createdAt: Date; id: string } | null {
  try {
    const [iso, rowId] = Buffer.from(cursor, 'base64url')
      .toString('utf8')
      .split('|');
    const createdAt = new Date(iso);
    if (!rowId || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: rowId };
  } catch {
    return null;
  }
}

export const REVIEWABLE_VERDICTS = ['NEEDS_REVIEW', 'ERROR'] as const;

export const reviewVerificationSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    note: safeText(500).optional(),
  })
  .strict();
export type ReviewVerificationInput = z.infer<typeof reviewVerificationSchema>;
