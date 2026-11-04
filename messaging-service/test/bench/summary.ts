import type { ScenarioResult } from './evaluate';

const pct = (values: number[], p: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
};

export function summarize(
  results: ScenarioResult[],
  rec: { spentUsd: number; budgetExceeded: boolean; llm: unknown[] },
  wallMs: number,
  dailyTokenLimit: number | null = null,
) {
  const ran = results.filter((r) => r.turns);
  const turns = ran.flatMap((r) => r.turns);
  const aiTurns = turns.filter((t) => t.route === 'IA');
  const routes: Record<string, number> = {
    plantilla: 0,
    directo: 0,
    IA: 0,
    ignorado: 0,
  };
  for (const t of turns) routes[t.route ?? 'ignorado']++;
  const flags: Record<string, number> = {};
  for (const r of ran) for (const f of r.flags) flags[f] = (flags[f] ?? 0) + 1;
  const turnFlags: Record<string, number> = {};
  for (const t of turns)
    for (const f of t.flags ?? []) turnFlags[f] = (turnFlags[f] ?? 0) + 1;
  const regular = ran.filter((r) => !r.knownFailure);
  const known = ran.filter((r) => r.knownFailure);
  const latencies = turns
    .map((t) => t.latencyMs)
    .filter((v): v is number => typeof v === 'number');
  const convCost = ran.map((r) => r.costUsd);
  return {
    scenarios: results.length,
    executed: ran.length,
    skipped: results.filter((r) => r.skipped).length,
    errors: results.filter((r) => r.error).length,
    passRegular: `${regular.filter((r) => r.pass).length}/${regular.length}`,
    knownFailuresReproduced: `${known.filter((r) => r.knownFailureReproduced).length}/${known.length}`,
    turns: turns.length,
    routes,
    aiTurns: aiTurns.length,
    llmCalls: rec.llm.length,
    perTurn: {
      inputTokens: {
        p50: pct(
          aiTurns.map((t) => t.inputTokens ?? 0),
          50,
        ),
        p95: pct(
          aiTurns.map((t) => t.inputTokens ?? 0),
          95,
        ),
      },
      outputTokens: {
        p50: pct(
          aiTurns.map((t) => t.outputTokens ?? 0),
          50,
        ),
        p95: pct(
          aiTurns.map((t) => t.outputTokens ?? 0),
          95,
        ),
      },
      thinkingTokens: {
        p50: pct(
          aiTurns.map((t) => t.thinkingTokens ?? 0),
          50,
        ),
        p95: pct(
          aiTurns.map((t) => t.thinkingTokens ?? 0),
          95,
        ),
        share:
          aiTurns.reduce((a, t) => a + (t.thinkingTokens ?? 0), 0) /
          Math.max(
            1,
            aiTurns.reduce((a, t) => a + (t.outputTokens ?? 0), 0),
          ),
      },
      llmCalls: {
        p50: pct(
          aiTurns.map((t) => t.llmCalls ?? 0),
          50,
        ),
        p95: pct(
          aiTurns.map((t) => t.llmCalls ?? 0),
          95,
        ),
      },
      toolCalls: {
        p50: pct(
          aiTurns.map((t) => t.tools?.length ?? 0),
          50,
        ),
        p95: pct(
          aiTurns.map((t) => t.tools?.length ?? 0),
          95,
        ),
      },
      costUsd: {
        p50: pct(
          aiTurns.map((t) => t.costUsd ?? 0),
          50,
        ),
        p95: pct(
          aiTurns.map((t) => t.costUsd ?? 0),
          95,
        ),
      },
      latencyMs: { p50: pct(latencies, 50), p95: pct(latencies, 95) },
      llmMs: {
        p50: pct(
          aiTurns.map((t) => t.llmMs ?? 0),
          50,
        ),
        p95: pct(
          aiTurns.map((t) => t.llmMs ?? 0),
          95,
        ),
      },
    },
    perConversation: {
      costUsd: { p50: pct(convCost, 50), p95: pct(convCost, 95) },
      tokens: {
        p50: pct(
          ran.map((r) => r.inputTokens + r.outputTokens),
          50,
        ),
        p95: pct(
          ran.map((r) => r.inputTokens + r.outputTokens),
          95,
        ),
      },
      projectedPer1000Usd:
        (convCost.reduce((a, b) => a + b, 0) / Math.max(1, ran.length)) * 1000,
      meanBillableTokens: Math.round(
        ran.reduce((a, r) => a + r.billableTokens, 0) / Math.max(1, ran.length),
      ),
      meanTokens: Math.round(
        ran.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0) /
          Math.max(1, ran.length),
      ),
      conversationsPerDailyCap: dailyTokenLimit
        ? Math.floor(
            dailyTokenLimit /
              Math.max(
                1,
                ran.reduce((a, r) => a + r.billableTokens, 0) /
                  Math.max(1, ran.length),
              ),
          )
        : null,
      dailyTokenLimit,
    },
    scenarioFlags: flags,
    turnFlags,
    spentUsd: rec.spentUsd,
    budgetExceeded: rec.budgetExceeded,
    wallMs,
  };
}

export function renderSummary(
  summary: ReturnType<typeof summarize>,
  results: ScenarioResult[],
): string {
  const s = summary;
  const usd = (v: number) => `$${v.toFixed(5)}`;
  const lines = [
    `# Línea base del banco de conversaciones`,
    ``,
    `| Métrica | Valor |`,
    `|---|---|`,
    `| Conversaciones ejecutadas | ${s.executed}/${s.scenarios} (omitidas ${s.skipped}, errores ${s.errors}) |`,
    `| Aciertos (sin fallos conocidos) | ${s.passRegular} |`,
    `| Fallos conocidos reproducidos | ${s.knownFailuresReproduced} |`,
    `| Turnos | ${s.turns} (IA ${s.routes.IA}, directo ${s.routes.directo}, plantilla ${s.routes.plantilla}, ignorado ${s.routes.ignorado}) |`,
    `| Llamadas al modelo | ${s.llmCalls} |`,
    `| Tokens entrada/turno IA p50 / p95 | ${s.perTurn.inputTokens.p50} / ${s.perTurn.inputTokens.p95} |`,
    `| Tokens salida/turno IA p50 / p95 | ${s.perTurn.outputTokens.p50} / ${s.perTurn.outputTokens.p95} |`,
    `| De la salida, razonamiento (thinking)/turno IA p50 / p95 | ${s.perTurn.thinkingTokens.p50} / ${s.perTurn.thinkingTokens.p95} (${Math.round(s.perTurn.thinkingTokens.share * 100)} % de la salida) |`,
    `| Llamadas LLM/turno IA p50 / p95 | ${s.perTurn.llmCalls.p50} / ${s.perTurn.llmCalls.p95} |`,
    `| Herramientas/turno IA p50 / p95 | ${s.perTurn.toolCalls.p50} / ${s.perTurn.toolCalls.p95} |`,
    `| Costo/turno IA p50 / p95 | ${usd(s.perTurn.costUsd.p50)} / ${usd(s.perTurn.costUsd.p95)} |`,
    `| Costo/conversación p50 / p95 | ${usd(s.perConversation.costUsd.p50)} / ${usd(s.perConversation.costUsd.p95)} |`,
    `| Costo proyectado por 1.000 conversaciones | $${s.perConversation.projectedPer1000Usd.toFixed(2)} |`,
    `| Tokens crudos por conversación (media) | ${s.perConversation.meanTokens} |`,
    `| Tokens que descuenta Conduit por conversación (media, caché al 10 %) | ${s.perConversation.meanBillableTokens} |`,
    `| Conversaciones que caben en el tope diario de producción | ${s.perConversation.conversationsPerDailyCap ?? 'sin tope'}${s.perConversation.dailyTokenLimit ? ` (tope ${s.perConversation.dailyTokenLimit} tokens/día)` : ''} |`,
    `| Latencia mensaje→respuesta p50 / p95 (incluye debounce) | ${s.perTurn.latencyMs.p50} / ${s.perTurn.latencyMs.p95} ms |`,
    `| Tiempo de modelo por turno p50 / p95 | ${s.perTurn.llmMs.p50} / ${s.perTurn.llmMs.p95} ms |`,
    `| Banderas por turno | ${
      Object.entries(s.turnFlags)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ') || 'ninguna'
    } |`,
    `| Gasto total | $${s.spentUsd.toFixed(4)}${s.budgetExceeded ? ' (presupuesto agotado)' : ''} |`,
    ``,
    `| Caso | Categoría | Resultado | Rutas | Herramientas | Tokens in/out | Costo | Banderas | Fallas |`,
    `|---|---|---|---|---|---|---|---|---|`,
  ];
  for (const r of results) {
    if (!r.turns) {
      lines.push(
        `| ${r.id} | — | ${r.skipped ? 'omitido' : 'error'} | — | — | — | — | — | ${(r.error ?? r.skipped ?? '').replace(/\|/g, '/')} |`,
      );
      continue;
    }
    const verdict = r.knownFailure
      ? r.knownFailureReproduced
        ? `falla esperada (${r.knownFailure}) ✔`
        : `${r.knownFailure} no se reprodujo`
      : r.pass
        ? 'OK'
        : 'FALLA';
    lines.push(
      `| ${r.id} ${r.title} | ${r.category} | ${verdict} | ${r.turns.map((t) => t.route).join(' → ')} | ${[...new Set(r.tools)].join(', ')} | ${r.inputTokens}/${r.outputTokens} | ${usd(r.costUsd)} | ${r.flags.join(', ')} | ${r.failures.join('; ').replace(/\|/g, '/')} |`,
    );
  }
  return lines.join('\n');
}
