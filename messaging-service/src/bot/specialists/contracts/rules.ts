import { z } from 'zod';
import {
  OutputSchemaDocument,
  VariableType,
  findVariable,
  variableNameSchema,
} from './output-schema';
import { isRealCalendarDate } from './extraction';
import { safeText } from './keys';

export const RULES_VERSION = 1;
export const MAX_RULES = 20;
export const MAX_IN_VALUES = 10;

export const RULE_OPERATORS = [
  'gte',
  'lte',
  'eq',
  'in',
  'within_days',
  'contains',
  'fuzzy',
  'within',
] as const;
export const RULE_FAILURE_VERDICTS = ['INVALID', 'NEEDS_REVIEW'] as const;

export const DEFAULT_FUZZY_THRESHOLD = 0.8;

export type RuleOperator = (typeof RULE_OPERATORS)[number];

export const OPERATORS_BY_TYPE: Record<VariableType, readonly RuleOperator[]> =
  {
    number: ['gte', 'lte', 'eq'],
    date: ['within_days', 'eq'],
    string: ['eq', 'contains', 'fuzzy', 'in', 'within'],
    boolean: ['eq'],
    enum: ['eq', 'in'],
  };

export const ruleRefSchema = z.union([
  z
    .string()
    .regex(/^grounding\.[a-z][a-zA-Z0-9_]{0,39}$/)
    .describe('grounding.<clave>'),
  z
    .object({
      literal: z.union([
        z.number().finite(),
        safeText(120),
        z.boolean(),
        z.array(safeText(120)).min(1).max(MAX_IN_VALUES),
      ]),
    })
    .strict(),
]);

export const ruleSchema = z
  .object({
    field: variableNameSchema,
    op: z.enum(RULE_OPERATORS),
    ref: ruleRefSchema,
    onFail: z.enum(RULE_FAILURE_VERDICTS),
    threshold: z.number().min(0.5).max(1).optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });

    if (rule.threshold !== undefined && rule.op !== 'fuzzy') {
      issue('threshold', 'threshold solo aplica al operador fuzzy');
    }

    if (typeof rule.ref !== 'object') {
      if (rule.op === 'in') {
        issue('ref', 'El operador in exige una lista literal');
      }
      return;
    }
    const literal = rule.ref.literal;

    if (rule.op === 'in') {
      if (!Array.isArray(literal)) {
        issue('ref', 'El operador in exige una lista literal');
      } else if (literal.some((item) => item.trim() === '')) {
        issue('ref', 'La lista no puede tener textos vacíos');
      }
      return;
    }
    if (Array.isArray(literal)) {
      issue('ref', 'Solo el operador in admite una lista');
      return;
    }

    const wantsNumber =
      rule.op === 'gte' || rule.op === 'lte' || rule.op === 'within_days';
    const wantsText =
      rule.op === 'contains' || rule.op === 'fuzzy' || rule.op === 'within';

    if (wantsNumber && typeof literal !== 'number') {
      issue('ref', `El operador ${rule.op} exige un literal numérico`);
      return;
    }
    if (wantsText && typeof literal !== 'string') {
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

export interface RuleIssue {
  index: number;
  message: string;
}

export function validateRulesAgainst(
  schema: OutputSchemaDocument,
  rules: RulesDocument,
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  for (const [index, rule] of rules.rules.entries()) {
    const variable = findVariable(schema, rule.field);
    if (!variable) {
      issues.push({
        index,
        message: `La regla cita la variable ${rule.field}, que no está declarada`,
      });
      continue;
    }
    if (!OPERATORS_BY_TYPE[variable.type].includes(rule.op)) {
      issues.push({
        index,
        message: `El operador ${rule.op} no aplica a la variable ${rule.field} (${variable.type}); admite: ${OPERATORS_BY_TYPE[variable.type].join(', ')}`,
      });
      continue;
    }
    if (typeof rule.ref !== 'object') continue;

    const literal = rule.ref.literal;
    if (rule.op === 'eq') {
      const message = eqLiteralIssue(variable, literal);
      if (message) issues.push({ index, message });
    }
    if (
      rule.op === 'in' &&
      variable.type === 'enum' &&
      Array.isArray(literal)
    ) {
      const unknown = literal.filter((item) => !variable.values.includes(item));
      if (unknown.length > 0) {
        issues.push({
          index,
          message: `La lista incluye valores que ${rule.field} no admite: ${unknown.join(', ')}`,
        });
      }
    }
  }
  return issues;
}

function eqLiteralIssue(
  variable: NonNullable<ReturnType<typeof findVariable>>,
  literal: unknown,
): string | null {
  switch (variable.type) {
    case 'number':
      return typeof literal === 'number'
        ? null
        : `${variable.name} exige un literal numérico`;
    case 'boolean':
      return typeof literal === 'boolean'
        ? null
        : `${variable.name} exige un literal verdadero o falso`;
    case 'date':
      return typeof literal === 'string' && isRealCalendarDate(literal)
        ? null
        : `${variable.name} exige una fecha real YYYY-MM-DD`;
    case 'enum':
      return typeof literal === 'string' && variable.values.includes(literal)
        ? null
        : `${variable.name} exige uno de: ${variable.values.join(', ')}`;
    case 'string':
      return typeof literal === 'string'
        ? null
        : `${variable.name} exige un literal de texto`;
  }
}
