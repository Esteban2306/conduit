import { EvalComparison } from './eval-compare';
import { EvalRunResult } from './eval-run';
import { EVAL_VERDICTS } from './eval-case';

const pct = (value: number | null): string =>
  value === null ? 'n/d' : `${(value * 100).toFixed(1)}%`;
const num = (value: number | null): string =>
  value === null ? 'n/d' : String(value);
const signed = (value: number | null): string =>
  value === null ? 'n/d' : `${value > 0 ? '+' : ''}${value}`;

export function formatRun(run: EvalRunResult): string {
  const s = run.summary;
  const lines: string[] = [
    `Especialista: ${run.specialist.key} (v${run.specialist.version}, ${run.specialist.capability})`,
    `Borrador usado: prompt=${run.draftUsed.promptTemplate} reglas=${run.draftUsed.rules} contexto=${run.draftUsed.contextSources}`,
    `Modelos: ${run.models.join(', ') || '(ninguno)'}`,
    `Casos: ${s.cases} | evaluados: ${s.evaluated} | omitidos por presupuesto: ${s.skipped}`,
    '',
    `Acierto de veredicto: ${pct(s.verdictAccuracy)}`,
    `Falsos válidos (esperado distinto de VALID y salió VALID): ${s.falseValid}`,
    `Falsos rechazos (esperado VALID y no salió VALID): ${s.falseReject}`,
    `Errores del especialista: ${s.errors}`,
    '',
    'Matriz (filas: esperado, columnas: obtenido)',
    `                ${EVAL_VERDICTS.map((v) => v.padEnd(16)).join('')}`,
    ...EVAL_VERDICTS.map(
      (expected) =>
        `${expected.padEnd(16)}${EVAL_VERDICTS.map((actual) =>
          String(s.confusion[expected][actual]).padEnd(16),
        ).join('')}`,
    ),
    '',
    'Acierto por campo (solo los campos esperados en el banco)',
    ...Object.entries(s.fieldAccuracy)
      .filter(([, stat]) => stat.checked > 0)
      .map(
        ([name, stat]) =>
          `  ${name.padEnd(11)} ${stat.correct}/${stat.checked} (${pct(stat.rate)})`,
      ),
    '',
    `Latencia p50/p95: ${num(s.latencyMs.p50)} / ${num(s.latencyMs.p95)} ms`,
    `Tokens: ${s.tokens.total} (entrada ${s.tokens.input}, salida ${s.tokens.output}); llamadas sin desglose: ${s.tokens.callsWithoutBreakdown}`,
    `Costo estimado: ${s.costUsd.total} USD${s.costUsd.casesWithoutCost > 0 ? ` (sin precio o sin desglose en ${s.costUsd.casesWithoutCost} caso(s): es un mínimo)` : ''}`,
  ];
  if (run.stoppedByBudget) {
    lines.push(
      '',
      `ATENCIÓN: se detuvo por el presupuesto (${run.limits.maxCostUsd} USD / ${run.limits.maxTokens} tokens).`,
    );
  }
  const wrong = run.cases.filter(
    (c) =>
      c.status === 'DONE' && (!c.verdictMatch || c.fieldMismatches.length > 0),
  );
  if (wrong.length > 0) {
    lines.push('', 'Casos con diferencias');
    for (const c of wrong) {
      const fields =
        c.fieldMismatches.length > 0
          ? ` campos: ${c.fieldMismatches.join(',')}`
          : '';
      lines.push(
        `  ${c.id}: esperado ${c.expected.verdict}, obtenido ${c.actual!.verdict} [${c.actual!.reasonCodes.join(',')}]${fields}`,
      );
    }
  }
  return lines.join('\n');
}

export function formatComparison(cmp: EvalComparison): string {
  const lines: string[] = [
    `Casos comparados: ${cmp.commonCases}${cmp.sameBank ? '' : ' (los bancos no son idénticos)'}`,
  ];
  for (const warning of cmp.warnings) lines.push(`ATENCIÓN: ${warning}`);
  lines.push('', 'Métrica                    A          B          cambio');
  for (const [name, m] of Object.entries(cmp.metrics)) {
    const isRate = name === 'verdictAccuracy' || name.startsWith('field.');
    const show = (v: number | null) => (isRate ? pct(v) : num(v));
    lines.push(
      `${name.padEnd(26)} ${show(m.a).padEnd(10)} ${show(m.b).padEnd(10)} ${isRate && m.delta !== null ? `${signed(Math.round(m.delta * 1000) / 10)} pp` : signed(m.delta)}`,
    );
  }
  const section = (title: string, diffs: EvalComparison['regressions']) => {
    if (diffs.length === 0) return;
    lines.push('', title);
    for (const d of diffs) {
      lines.push(`  ${d.id}: esperado ${d.expected}, A=${d.a}, B=${d.b}`);
    }
  };
  section('Regresiones (A acertaba y B no)', cmp.regressions);
  section('Mejoras (A fallaba y B acierta)', cmp.improvements);
  section('Cambiaron pero siguen mal', cmp.changedStillWrong);
  lines.push(
    '',
    cmp.safetyRegression
      ? 'ALERTA DE SEGURIDAD: B deja pasar como VÁLIDAS más imágenes que no lo eran.'
      : 'Sin aumento de falsos válidos.',
    cmp.worse
      ? 'Conclusión: B es peor o no mejora a A.'
      : 'Conclusión: B no es peor que A en este banco.',
  );
  return lines.join('\n');
}
