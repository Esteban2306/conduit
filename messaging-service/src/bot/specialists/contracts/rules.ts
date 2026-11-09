import { z } from 'zod';
import { ExtractionFieldName, extractionFieldNameSchema } from './extraction';
import { safeText } from './keys';

export const RULES_VERSION = 1;
export const MAX_RULES = 20;

export const RULE_OPERATORS = [
  'gte',
  'lte',
  'eq',
  'within_days',
  'contains',
  'fuzzy',
] as const;
export const RULE_FAILURE_VERDICTS = ['INVALID', 'NEEDS_REVIEW'] as const;

export const DEFAULT_FUZZY_THRESHOLD = 0.8;

export type RuleOperator = (typeof RULE_OPERATORS)[number];

export const OPERATOR_FIELDS: Record<
  RuleOperator,
  readonly ExtractionFieldName[]
> = {
  gte: ['amount'],
  lte: ['amount'],
  within_days: ['date'],
  eq: ['amount', 'currency', 'date', 'reference', 'recipient', 'legibility'],
  contains: ['reference', 'recipient'],
  fuzzy: ['reference', 'recipient'],
};

export const ruleRefSchema = z.union([
  z
    .string()
    .regex(/^grounding\.[a-z][a-zA-Z0-9_]{0,39}$/)
    .describe('grounding.<clave>'),
  z
    .object({
      literal: z.union([z.number().finite(), safeText(120)]),
    })
    .strict(),
]);

export const ruleSchema = z
  .object({
    field: extractionFieldNameSchema,
    op: z.enum(RULE_OPERATORS),
    ref: ruleRefSchema,
    onFail: z.enum(RULE_FAILURE_VERDICTS),
    threshold: z.number().min(0.5).max(1).optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });

    if (!OPERATOR_FIELDS[rule.op].includes(rule.field)) {
      issue(
        'field',
        `El operador ${rule.op} solo aplica a: ${OPERATOR_FIELDS[rule.op].join(', ')}`,
      );
    }

    if (rule.threshold !== undefined && rule.op !== 'fuzzy') {
      issue('threshold', 'threshold solo aplica al operador fuzzy');
    }

    if (typeof rule.ref !== 'object') return;
    const literal = rule.ref.literal;
    const wantsNumber =
      rule.op === 'gte' ||
      rule.op === 'lte' ||
      rule.op === 'within_days' ||
      (rule.op === 'eq' && rule.field === 'amount');

    if (wantsNumber && typeof literal !== 'number') {
      issue('ref', `El operador ${rule.op} exige un literal numérico`);
      return;
    }
    if (!wantsNumber && typeof literal !== 'string') {
      issue('ref', `El operador ${rule.op} exige un literal de texto`);
      return;
    }
    if (typeof literal === 'string' && literal.trim() === '') {
      issue('ref', 'El literal de texto no puede estar vacío');
    }
    if (
      rule.op === 'within_days' &&
      typeof literal === 'number' &&
      (!Number.isInteger(literal) || literal < 0)
    ) {
      issue('ref', 'within_days exige un literal entero mayor o igual a 0');
    }
  });
export type Rule = z.infer<typeof ruleSchema>;

export const rulesDocumentSchema = z
  .object({
    version: z.literal(RULES_VERSION),
    rules: z.array(ruleSchema).max(MAX_RULES),
  })
  .strict();
export type RulesDocument = z.infer<typeof rulesDocumentSchema>;

export const EMPTY_RULES: RulesDocument = { version: RULES_VERSION, rules: [] };
