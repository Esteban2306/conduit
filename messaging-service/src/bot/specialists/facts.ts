import { z } from 'zod';
import {
  MAX_HUMAN_SUMMARY,
  VERDICTS,
  VerificationResult,
  capabilitySchema,
  reasonCodeSchema,
  safeText,
} from './contracts';

export const FACTS_KEY = 'facts';
export const MAX_FACTS = 5;
export const MAX_FACT_REASONS = 5;
export const MAX_RENDERED_FACTS = 3;

const PENDING_VERDICTS = new Set(['NEEDS_REVIEW', 'ERROR']);

export const factEntrySchema = z
  .object({
    verdict: z.enum(VERDICTS),
    confidence: z.number().min(0).max(1),
    reasonCodes: z.array(reasonCodeSchema).max(MAX_FACT_REASONS),
    amount: z.number().finite().min(0).max(1e12).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    summary: safeText(MAX_HUMAN_SUMMARY),
    verificationId: z.string().uuid().nullable(),
    at: z.string().datetime(),
    validUntil: z.string().datetime(),
    pendingReview: z.boolean(),
  })
  .strict();
export type FactEntry = z.infer<typeof factEntrySchema>;

export function buildFact(
  result: VerificationResult,
  verificationId: string | null,
  validUntil: Date,
  now: Date = new Date(),
): FactEntry {
  const { amount, currency, date } = result.fields;
  return {
    verdict: result.verdict,
    confidence: Math.round(result.confidence * 100) / 100,
    reasonCodes: result.reasonCodes.slice(0, MAX_FACT_REASONS),
    ...(typeof amount === 'number' && { amount }),
    ...(typeof currency === 'string' && { currency }),
    ...(typeof date === 'string' && { date }),
    summary: result.humanSummary,
    verificationId,
    at: now.toISOString(),
    validUntil: validUntil.toISOString(),
    pendingReview: PENDING_VERDICTS.has(result.verdict),
  };
}

function validEntries(raw: unknown): Array<[string, FactEntry]> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const entries: Array<[string, FactEntry]> = [];
  for (const [capability, value] of Object.entries(raw)) {
    if (!capabilitySchema.safeParse(capability).success) continue;
    const parsed = factEntrySchema.safeParse(value);
    if (parsed.success) entries.push([capability, parsed.data]);
  }
  return entries;
}

export function mergeFacts(
  existing: unknown,
  capability: string,
  entry: FactEntry,
): Record<string, FactEntry> {
  const kept = validEntries(existing).filter(([key]) => key !== capability);
  kept.push([capability, entry]);
  kept.sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at));
  return Object.fromEntries(kept.slice(0, MAX_FACTS));
}

export function readFacts(
  raw: unknown,
  now: Date = new Date(),
): Array<[string, FactEntry]> {
  return validEntries(raw)
    .filter(([, entry]) => Date.parse(entry.validUntil) > now.getTime())
    .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))
    .slice(0, MAX_RENDERED_FACTS);
}

export function renderFacts(
  raw: unknown,
  now: Date = new Date(),
): string | null {
  const facts = readFacts(raw, now);
  if (facts.length === 0) return null;

  const lines = facts.map(([capability, entry]) => {
    const data = [
      typeof entry.amount === 'number'
        ? `monto ${entry.amount}${entry.currency ? ` ${entry.currency}` : ''}`
        : null,
      entry.date ? `fecha ${entry.date}` : null,
    ].filter(Boolean);
    const parts = [
      `${capability}: ${entry.verdict} (confianza ${entry.confidence})`,
      data.length > 0 ? data.join(', ') : null,
      entry.reasonCodes.length > 0
        ? `motivos ${entry.reasonCodes.join(', ')}`
        : null,
      entry.summary,
      entry.pendingReview
        ? 'Pendiente de revisión humana: no lo confirmes ni lo rechaces por tu cuenta.'
        : null,
    ].filter(Boolean);
    return `- ${parts.join('. ')}`;
  });

  return `Verificaciones del sistema (no las contradigas):\n${lines.join('\n')}`;
}
