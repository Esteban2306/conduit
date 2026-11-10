import {
  EVAL_VERDICTS,
  EvalFieldName,
  EvalVerdict,
  Expected,
} from './eval-case';
import { OutputSchemaDocument, Variable, findVariable } from '../contracts';

export interface ActualOutcome {
  verdict: EvalVerdict;
  confidence: number;
  fields: Partial<Record<EvalFieldName, unknown>>;
  reasonCodes: string[];
}

export interface CaseTokens {
  input: number | null;
  output: number | null;
  total: number;
}

export interface CaseResult {
  id: string;
  imageSha256: string;
  status: 'DONE' | 'SKIPPED_BUDGET';
  expected: Expected;
  actual: ActualOutcome | null;
  verdictMatch: boolean;
  falseValid: boolean;
  falseReject: boolean;
  fieldMismatches: EvalFieldName[];
  tokens: CaseTokens;
  latencyMs: number;
  modelUsed: string | null;
  costUsd: number | null;
}

const normalizeText = (value: unknown): string =>
  String(value).trim().toLowerCase().replace(/\s+/g, ' ');

const EXACT_EPSILON = 1e-9;

export function fieldEquals(
  variable: Variable | undefined,
  expected: unknown,
  actual: unknown,
): boolean {
  if (expected === null || expected === undefined) {
    return actual === null || actual === undefined;
  }
  if (actual === null || actual === undefined) return false;
  if (variable?.type === 'number') {
    const tolerance = variable.tolerance ?? 0;
    return (
      Math.abs(Number(expected) - Number(actual)) <= tolerance + EXACT_EPSILON
    );
  }
  if (
    variable?.type === 'boolean' ||
    variable?.type === 'enum' ||
    variable?.type === 'date'
  ) {
    return expected === actual;
  }
  return normalizeText(expected) === normalizeText(actual);
}

export function compareFields(
  expected: Expected['fields'],
  actual: ActualOutcome['fields'],
  schema: OutputSchemaDocument,
): EvalFieldName[] {
  if (!expected) return [];
  return Object.keys(expected).filter(
    (name) =>
      !fieldEquals(findVariable(schema, name), expected[name], actual[name]),
  );
}

export function scoreCase(
  base: Pick<CaseResult, 'id' | 'imageSha256' | 'expected'>,
  schema: OutputSchemaDocument,
  run: {
    actual: ActualOutcome;
    tokens: CaseTokens;
    latencyMs: number;
    modelUsed: string | null;
    costUsd: number | null;
  },
): CaseResult {
  const { expected } = base;
  const { actual } = run;
  return {
    ...base,
    status: 'DONE',
    actual,
    verdictMatch: actual.verdict === expected.verdict,
    falseValid: expected.verdict !== 'VALID' && actual.verdict === 'VALID',
    falseReject: expected.verdict === 'VALID' && actual.verdict !== 'VALID',
    fieldMismatches: compareFields(expected.fields, actual.fields, schema),
    tokens: run.tokens,
    latencyMs: run.latencyMs,
    modelUsed: run.modelUsed,
    costUsd: run.costUsd,
  };
}

export function skippedCase(
  base: Pick<CaseResult, 'id' | 'imageSha256' | 'expected'>,
): CaseResult {
  return {
    ...base,
    status: 'SKIPPED_BUDGET',
    actual: null,
    verdictMatch: false,
    falseValid: false,
    falseReject: false,
    fieldMismatches: [],
    tokens: { input: null, output: null, total: 0 },
    latencyMs: 0,
    modelUsed: null,
    costUsd: null,
  };
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const value =
    sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  return Math.round(value);
}

const rate = (part: number, total: number): number | null =>
  total === 0 ? null : Math.round((part / total) * 10_000) / 10_000;

export interface FieldStat {
  checked: number;
  correct: number;
  rate: number | null;
}

export interface EvalSummary {
  cases: number;
  evaluated: number;
  skipped: number;
  verdictAccuracy: number | null;
  falseValid: number;
  falseReject: number;
  errors: number;
  confusion: Record<string, Record<string, number>>;
  fieldAccuracy: Record<string, FieldStat>;
  latencyMs: { p50: number | null; p95: number | null };
  tokens: {
    total: number;
    input: number;
    output: number;
    callsWithoutBreakdown: number;
  };
  costUsd: { total: number; casesWithoutCost: number };
}

export function summarize(results: CaseResult[]): EvalSummary {
  const done = results.filter((r) => r.status === 'DONE');
  const confusion: Record<string, Record<string, number>> = {};
  for (const verdict of EVAL_VERDICTS) {
    confusion[verdict] = Object.fromEntries(EVAL_VERDICTS.map((v) => [v, 0]));
  }
  for (const r of done) confusion[r.expected.verdict][r.actual!.verdict] += 1;

  const fieldNames = [
    ...new Set(done.flatMap((r) => Object.keys(r.expected.fields ?? {}))),
  ].sort();
  const fieldAccuracy: Record<string, FieldStat> = {};
  for (const name of fieldNames) {
    const withField = done.filter(
      (r) => r.expected.fields && name in r.expected.fields,
    );
    const correct = withField.filter(
      (r) => !r.fieldMismatches.includes(name),
    ).length;
    fieldAccuracy[name] = {
      checked: withField.length,
      correct,
      rate: rate(correct, withField.length),
    };
  }

  const called = done.filter((r) => r.modelUsed !== null);
  const latencies = called.map((r) => r.latencyMs).sort((a, b) => a - b);
  const priced = done.filter((r) => r.costUsd !== null);

  return {
    cases: results.length,
    evaluated: done.length,
    skipped: results.length - done.length,
    verdictAccuracy: rate(
      done.filter((r) => r.verdictMatch).length,
      done.length,
    ),
    falseValid: done.filter((r) => r.falseValid).length,
    falseReject: done.filter((r) => r.falseReject).length,
    errors: done.filter((r) => r.actual!.verdict === 'ERROR').length,
    confusion,
    fieldAccuracy,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
    tokens: {
      total: done.reduce((sum, r) => sum + r.tokens.total, 0),
      input: done.reduce((sum, r) => sum + (r.tokens.input ?? 0), 0),
      output: done.reduce((sum, r) => sum + (r.tokens.output ?? 0), 0),
      callsWithoutBreakdown: called.filter((r) => r.tokens.input === null)
        .length,
    },
    costUsd: {
      total:
        Math.round(priced.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) * 1e6) /
        1e6,
      casesWithoutCost:
        called.length - called.filter((r) => r.costUsd !== null).length,
    },
  };
}

export const isCorrect = (r: CaseResult): boolean =>
  r.status === 'DONE' && r.verdictMatch && r.fieldMismatches.length === 0;
