import { z } from 'zod';
import { extractionFieldNameSchema } from './extraction';
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

export const ruleRefSchema = z.union([
  z
    .string()
    .regex(/^grounding\.[a-z][a-zA-Z0-9_]{0,39}$/)
    .describe('grounding.<clave>'),
  z
    .object({
      literal: z.union([z.number().finite(), z.boolean(), safeText(120)]),
    })
    .strict(),
]);

export const ruleSchema = z
  .object({
    field: extractionFieldNameSchema,
    op: z.enum(RULE_OPERATORS),
    ref: ruleRefSchema,
    onFail: z.enum(RULE_FAILURE_VERDICTS),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const numeric = rule.op === 'gte' || rule.op === 'lte';
    if (
      numeric &&
      typeof rule.ref === 'object' &&
      typeof rule.ref.literal !== 'number'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['ref'],
        message: `El operador ${rule.op} exige un literal numérico`,
      });
    }
    if (
      rule.op === 'within_days' &&
      typeof rule.ref === 'object' &&
      (typeof rule.ref.literal !== 'number' ||
        !Number.isInteger(rule.ref.literal) ||
        rule.ref.literal < 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['ref'],
        message: 'within_days exige un literal entero mayor o igual a 0',
      });
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
