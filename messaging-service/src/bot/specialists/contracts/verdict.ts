import { z } from 'zod';
import { variablesRecordSchema } from './extraction';
import { safeText } from './keys';

export const VERDICTS = [
  'VALID',
  'INVALID',
  'NEEDS_REVIEW',
  'UNREADABLE',
  'NOT_APPLICABLE',
  'ERROR',
] as const;
export const verdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof verdictSchema>;

export const VERDICT_VERSION = 1;
export const MAX_REASON_CODES = 10;
export const MAX_HUMAN_SUMMARY = 160;

export const reasonCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/);

export const verificationResultSchema = z
  .object({
    version: z.literal(VERDICT_VERSION),
    verdict: verdictSchema,
    confidence: z.number().min(0).max(1),
    fields: variablesRecordSchema,
    reasonCodes: z.array(reasonCodeSchema).max(MAX_REASON_CODES),
    humanSummary: safeText(MAX_HUMAN_SUMMARY),
  })
  .strict();
export type VerificationResult = z.infer<typeof verificationResultSchema>;
