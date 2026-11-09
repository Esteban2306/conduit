import { ZonedClock } from 'src/channels/whatsapp/utils/zoned-clock';
import {
  DEFAULT_FUZZY_THRESHOLD,
  ExtractedFields,
  MAX_REASON_CODES,
  Rule,
  RulesDocument,
} from './contracts';
import { containsTokens, fuzzySimilarity, normalizeText } from './text-match';

export type GroundingValue = string | number | boolean | null | undefined;
export type GroundingValues = Record<string, GroundingValue>;

export interface EvaluationContext {
  grounding: GroundingValues;
  now: Date;
  timeZone: string;
}

export type RuleStatus =
  | 'PASS'
  | 'FAIL'
  | 'MISSING_FIELD'
  | 'MISSING_GROUNDING'
  | 'INVALID_OPERAND';

export interface RuleResult {
  index: number;
  status: RuleStatus;
  reasonCode: string | null;
}

export type EvaluationVerdict = 'VALID' | 'INVALID' | 'NEEDS_REVIEW';

export interface Evaluation {
  verdict: EvaluationVerdict;
  reasonCodes: string[];
  results: RuleResult[];
}

const SEVERITY: Record<EvaluationVerdict, number> = {
  VALID: 0,
  NEEDS_REVIEW: 1,
  INVALID: 2,
};

const AMOUNT_TOLERANCE = 0.005;
const DAY_MS = 86_400_000;
const FUTURE_TOLERANCE_DAYS = 1;

type Operand = string | number;

function resolveOperand(
  rule: Rule,
  grounding: GroundingValues,
): Operand | null {
  if (typeof rule.ref === 'object') return rule.ref.literal;
  const value = grounding[rule.ref.slice('grounding.'.length)];
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return null;
  return value;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function dayNumber(dateKey: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
  const time = Date.parse(`${dateKey}T00:00:00Z`);
  return Number.isNaN(time) ? null : time / DAY_MS;
}

function compare(
  rule: Rule,
  fieldValue: string | number | boolean,
  operand: Operand,
  context: EvaluationContext,
): 'PASS' | 'FAIL' | 'INVALID_OPERAND' {
  switch (rule.op) {
    case 'gte':
    case 'lte': {
      const left = toNumber(fieldValue);
      const right = toNumber(operand);
      if (left === null || right === null) return 'INVALID_OPERAND';
      return (rule.op === 'gte' ? left >= right : left <= right)
        ? 'PASS'
        : 'FAIL';
    }
    case 'eq': {
      if (rule.field === 'amount') {
        const left = toNumber(fieldValue);
        const right = toNumber(operand);
        if (left === null || right === null) return 'INVALID_OPERAND';
        return Math.abs(left - right) < AMOUNT_TOLERANCE ? 'PASS' : 'FAIL';
      }
      return normalizeText(String(fieldValue)) ===
        normalizeText(String(operand))
        ? 'PASS'
        : 'FAIL';
    }
    case 'within_days': {
      const days = toNumber(operand);
      const paid = dayNumber(String(fieldValue));
      const today = dayNumber(
        new ZonedClock(context.timeZone).at(context.now).dateKey,
      );
      if (days === null || days < 0 || paid === null || today === null) {
        return 'INVALID_OPERAND';
      }
      const age = today - paid;
      return age >= -FUTURE_TOLERANCE_DAYS && age <= days ? 'PASS' : 'FAIL';
    }
    case 'contains':
      return containsTokens(String(fieldValue), String(operand))
        ? 'PASS'
        : 'FAIL';
    case 'fuzzy': {
      const threshold = rule.threshold ?? DEFAULT_FUZZY_THRESHOLD;
      return fuzzySimilarity(String(fieldValue), String(operand)) >= threshold
        ? 'PASS'
        : 'FAIL';
    }
  }
}

function evaluateRule(
  rule: Rule,
  index: number,
  fields: ExtractedFields,
  context: EvaluationContext,
): { result: RuleResult; severity: EvaluationVerdict } {
  const code = (suffix: string) => `${rule.field}_${suffix}`.toUpperCase();
  const outcome = (
    status: RuleStatus,
    severity: EvaluationVerdict,
    reasonCode: string | null,
  ) => ({ result: { index, status, reasonCode }, severity });

  const fieldValue = fields[rule.field];
  if (fieldValue === undefined || fieldValue === null) {
    return outcome('MISSING_FIELD', 'NEEDS_REVIEW', code('MISSING'));
  }

  const operand = resolveOperand(rule, context.grounding);
  if (operand === null) {
    return outcome(
      'MISSING_GROUNDING',
      'NEEDS_REVIEW',
      'GROUNDING_UNAVAILABLE',
    );
  }

  const status = compare(rule, fieldValue, operand, context);
  if (status === 'INVALID_OPERAND') {
    return outcome('INVALID_OPERAND', 'NEEDS_REVIEW', 'RULE_OPERAND_INVALID');
  }
  if (status === 'PASS') return outcome('PASS', 'VALID', null);
  return outcome('FAIL', rule.onFail, code(`${rule.op}_FAILED`));
}

export function evaluateRules(
  fields: ExtractedFields,
  rules: RulesDocument,
  context: EvaluationContext,
): Evaluation {
  if (rules.rules.length === 0) {
    return {
      verdict: 'VALID',
      reasonCodes: ['NO_RULES_CONFIGURED'],
      results: [],
    };
  }

  const evaluated = rules.rules.map((rule, index) =>
    evaluateRule(rule, index, fields, context),
  );

  let verdict: EvaluationVerdict = 'VALID';
  for (const { severity } of evaluated) {
    if (SEVERITY[severity] > SEVERITY[verdict]) verdict = severity;
  }

  const reasonCodes: string[] = [];
  const bySeverity = [...evaluated].sort(
    (a, b) => SEVERITY[b.severity] - SEVERITY[a.severity],
  );
  for (const { result } of bySeverity) {
    if (result.reasonCode && !reasonCodes.includes(result.reasonCode)) {
      reasonCodes.push(result.reasonCode);
    }
  }
  if (verdict === 'VALID') reasonCodes.push('RULES_PASSED');

  return {
    verdict,
    reasonCodes: reasonCodes.slice(0, MAX_REASON_CODES),
    results: evaluated.map((entry) => entry.result),
  };
}
