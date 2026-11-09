import { EvalRunResult, RESULT_VERSION } from './eval-run';
import { CaseResult, isCorrect } from './eval-scoring';

export type CaseChange =
  | 'REGRESSION'
  | 'IMPROVEMENT'
  | 'CHANGED_STILL_WRONG'
  | 'DIFFERENT_IMAGE';

export interface CaseDiff {
  id: string;
  change: CaseChange;
  expected: string;
  a: string;
  b: string;
}

export interface MetricDelta {
  a: number | null;
  b: number | null;
  delta: number | null;
}

export interface EvalComparison {
  commonCases: number;
  onlyInA: string[];
  onlyInB: string[];
  sameBank: boolean;
  warnings: string[];
  metrics: Record<string, MetricDelta>;
  regressions: CaseDiff[];
  improvements: CaseDiff[];
  changedStillWrong: CaseDiff[];
  safetyRegression: boolean;
  worse: boolean;
}

const delta = (a: number | null, b: number | null): MetricDelta => ({
  a,
  b,
  delta: a === null || b === null ? null : Math.round((b - a) * 1e6) / 1e6,
});

const label = (r: CaseResult): string =>
  r.status === 'DONE' ? r.actual!.verdict : 'OMITIDO';

export function parseRun(raw: unknown): EvalRunResult {
  const run = raw as Partial<EvalRunResult> | null;
  if (
    !run ||
    run.version !== RESULT_VERSION ||
    !Array.isArray(run.cases) ||
    !run.summary ||
    !run.specialist
  ) {
    throw new Error('El archivo no es un resultado de evaluación válido');
  }
  return run as EvalRunResult;
}

export function compareRuns(
  a: EvalRunResult,
  b: EvalRunResult,
): EvalComparison {
  const byIdA = new Map(a.cases.map((c) => [c.id, c]));
  const byIdB = new Map(b.cases.map((c) => [c.id, c]));
  const common = [...byIdA.keys()].filter((id) => byIdB.has(id)).sort();
  const onlyInA = [...byIdA.keys()].filter((id) => !byIdB.has(id)).sort();
  const onlyInB = [...byIdB.keys()].filter((id) => !byIdA.has(id)).sort();

  const warnings: string[] = [];
  const regressions: CaseDiff[] = [];
  const improvements: CaseDiff[] = [];
  const changedStillWrong: CaseDiff[] = [];
  const comparable: Array<[CaseResult, CaseResult]> = [];

  for (const id of common) {
    const ca = byIdA.get(id)!;
    const cb = byIdB.get(id)!;
    if (ca.imageSha256 !== cb.imageSha256) {
      warnings.push(
        `El caso ${id} tiene una imagen distinta en cada corrida y se excluye`,
      );
      continue;
    }
    if (ca.status !== 'DONE' || cb.status !== 'DONE') {
      warnings.push(
        `El caso ${id} se omitió por presupuesto en una corrida y se excluye`,
      );
      continue;
    }
    comparable.push([ca, cb]);
    const diff = (change: CaseChange): CaseDiff => ({
      id,
      change,
      expected: ca.expected.verdict,
      a: label(ca),
      b: label(cb),
    });
    const okA = isCorrect(ca);
    const okB = isCorrect(cb);
    if (okA && !okB) regressions.push(diff('REGRESSION'));
    else if (!okA && okB) improvements.push(diff('IMPROVEMENT'));
    else if (!okA && !okB && ca.actual!.verdict !== cb.actual!.verdict) {
      changedStillWrong.push(diff('CHANGED_STILL_WRONG'));
    }
  }

  if (onlyInA.length > 0 || onlyInB.length > 0) {
    warnings.push(
      `Los bancos difieren: ${onlyInA.length} caso(s) solo en A y ${onlyInB.length} solo en B; solo se comparan los comunes`,
    );
  }
  if (
    a.bankSha256 !== b.bankSha256 &&
    onlyInA.length === 0 &&
    onlyInB.length === 0
  ) {
    warnings.push(
      'Los casos comunes tienen contenido esperado o imágenes distintas entre corridas',
    );
  }
  if (comparable.length === 0) warnings.push('No hay casos comparables');

  const stat = (side: 0 | 1, f: (r: CaseResult) => boolean) =>
    comparable.filter((pair) => f(pair[side])).length;
  const share = (side: 0 | 1, f: (r: CaseResult) => boolean): number | null =>
    comparable.length === 0
      ? null
      : Math.round((stat(side, f) / comparable.length) * 10_000) / 10_000;

  const metrics: Record<string, MetricDelta> = {
    verdictAccuracy: delta(
      share(0, (r) => r.verdictMatch),
      share(1, (r) => r.verdictMatch),
    ),
    falseValid: delta(
      stat(0, (r) => r.falseValid),
      stat(1, (r) => r.falseValid),
    ),
    falseReject: delta(
      stat(0, (r) => r.falseReject),
      stat(1, (r) => r.falseReject),
    ),
    errors: delta(
      stat(0, (r) => r.actual!.verdict === 'ERROR'),
      stat(1, (r) => r.actual!.verdict === 'ERROR'),
    ),
    latencyP50Ms: delta(a.summary.latencyMs.p50, b.summary.latencyMs.p50),
    latencyP95Ms: delta(a.summary.latencyMs.p95, b.summary.latencyMs.p95),
    tokensTotal: delta(a.summary.tokens.total, b.summary.tokens.total),
    costUsd: delta(a.summary.costUsd.total, b.summary.costUsd.total),
  };
  for (const name of Object.keys(a.summary.fieldAccuracy)) {
    metrics[`field.${name}`] = delta(
      a.summary.fieldAccuracy[name]?.rate ?? null,
      b.summary.fieldAccuracy[name]?.rate ?? null,
    );
  }

  const safetyRegression = (metrics.falseValid.delta ?? 0) > 0;
  const accuracyDrop = (metrics.verdictAccuracy.delta ?? 0) < 0;

  return {
    commonCases: comparable.length,
    onlyInA,
    onlyInB,
    sameBank: a.bankSha256 === b.bankSha256,
    warnings,
    metrics,
    regressions,
    improvements,
    changedStillWrong,
    safetyRegression,
    worse:
      safetyRegression ||
      accuracyDrop ||
      regressions.length > improvements.length,
  };
}
