import { z } from 'zod';
import {
  MAX_HUMAN_SUMMARY,
  OutputSchemaDocument,
  VERDICTS,
  Variables,
  VerificationResult,
  capabilitySchema,
  reasonCodeSchema,
  safeText,
} from './contracts';

export const FACTS_KEY = 'facts';
export const MAX_FACTS = 5;
export const MAX_FACT_REASONS = 5;
export const MAX_RENDERED_FACTS = 3;
export const MAX_FACT_VARIABLES = 8;
export const MAX_FACT_TEXT = 64;

const factVariablesSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{0,19}$/),
    z.union([safeText(MAX_FACT_TEXT), z.number().finite(), z.boolean()]),
  )
  .refine((record) => Object.keys(record).length <= MAX_FACT_VARIABLES, {
    message: 'Demasiadas variables',
  });

const PENDING_VERDICTS = new Set(['NEEDS_REVIEW', 'ERROR']);

export const factEntrySchema = z
  .object({
    verdict: z.enum(VERDICTS),
    confidence: z.number().min(0).max(1),
    reasonCodes: z.array(reasonCodeSchema).max(MAX_FACT_REASONS),
    variables: factVariablesSchema.optional(),
    summary: safeText(MAX_HUMAN_SUMMARY),
    verificationId: z.string().uuid().nullable(),
    at: z.string().datetime(),
    validUntil: z.string().datetime(),
    pendingReview: z.boolean(),
    consumed: z.boolean().optional(),
  })
  .strict();
export type FactEntry = z.infer<typeof factEntrySchema>;

export function exposedVariables(
  schema: OutputSchemaDocument,
  variables: Variables,
): Record<string, string | number | boolean> {
  const allowed: Variables = {};
  for (const variable of schema.variables) {
    const exposable =
      variable.type !== 'string' || variable.exposeToBot === true;
    if (exposable && variable.name in variables) {
      allowed[variable.name] = variables[variable.name];
    }
  }
  return factVariables(allowed);
}

export function buildFact(
  result: VerificationResult,
  verificationId: string | null,
  validUntil: Date,
  exposed: Record<string, string | number | boolean>,
  now: Date = new Date(),
): FactEntry {
  const variables = factVariables(exposed);
  return {
    verdict: result.verdict,
    confidence: Math.round(result.confidence * 100) / 100,
    reasonCodes: result.reasonCodes.slice(0, MAX_FACT_REASONS),
    ...(Object.keys(variables).length > 0 && { variables }),
    summary: result.humanSummary,
    verificationId,
    at: now.toISOString(),
    validUntil: validUntil.toISOString(),
    pendingReview: PENDING_VERDICTS.has(result.verdict),
  };
}

function factVariables(
  fields: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean> {
  const picked: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (Object.keys(picked).length >= MAX_FACT_VARIABLES) break;
    if (value === null || value === undefined) continue;
    const candidate =
      typeof value === 'string' ? value.slice(0, MAX_FACT_TEXT) : value;
    const parsed = factVariablesSchema.safeParse({ [name]: candidate });
    if (parsed.success) picked[name] = candidate;
  }
  return picked;
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

export function markConsumed(
  raw: unknown,
  capability: string,
): Record<string, FactEntry> | null {
  const entries = validEntries(raw);
  const target = entries.find(([key]) => key === capability);
  if (!target) return null;
  return Object.fromEntries(
    entries.map(([key, entry]) =>
      key === capability
        ? [key, { ...entry, consumed: true, pendingReview: false }]
        : [key, entry],
    ),
  );
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
    const data = Object.entries(entry.variables ?? {}).map(
      ([name, value]) => `${name}: ${String(value)}`,
    );
    const parts = [
      `${capability}: ${entry.verdict} (confianza ${entry.confidence})`,
      data.length > 0 ? data.join(', ') : null,
      entry.reasonCodes.length > 0
        ? `motivos ${entry.reasonCodes.join(', ')}`
        : null,
      entry.summary,
      entry.consumed
        ? 'Ya se utilizó en una acción: no se puede reutilizar.'
        : null,
      entry.pendingReview
        ? 'Pendiente de revisión humana: no lo confirmes ni lo rechaces por tu cuenta.'
        : null,
    ].filter(Boolean);
    return `- ${parts.join('. ')}`;
  });

  return `Verificaciones del sistema (no las contradigas):\n${lines.join('\n')}`;
}
