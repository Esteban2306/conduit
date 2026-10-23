import * as fs from 'fs';
import * as path from 'path';
import { BENCH, RESULTS_DIR } from './bench.config';
import { recorder } from './recorder';
import type { ScenarioResult } from './evaluate';
import { createRunner, Scenario } from './scenario-runner';
import { renderSummary, summarize } from './summary';
import { log, startStack } from './stack';

async function main(): Promise<void> {
  const started = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(RESULTS_DIR, stamp);
  const runtimeDir = path.join(outDir, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });

  const spec = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'scenarios.json'), 'utf8'),
  ) as { scenarios: Scenario[] };
  const filter = process.env.BENCH_ONLY?.split(',').filter(Boolean);
  const scenarios = filter
    ? spec.scenarios.filter((s) => filter.includes(s.id))
    : spec.scenarios;

  const stack = await startStack(outDir, runtimeDir);
  const { conduit } = stack;

  const { runScenario } = createRunner(stack);
  const results: ScenarioResult[] = [];
  const queue = [...scenarios];

  async function worker(connectionId: string): Promise<void> {
    for (;;) {
      const scenario = queue.shift();
      if (!scenario) return;
      if (recorder.budgetExceeded) {
        results.push({
          id: scenario.id,
          skipped: 'presupuesto agotado',
        } as ScenarioResult);
        continue;
      }
      try {
        const result = await runScenario(scenario, connectionId);
        results.push(result);
        log(
          `${scenario.id} ${result.pass ? 'OK   ' : 'FALLA'} ${scenario.title} (${result.turns.map((t) => t.route).join(', ')}) $${result.costUsd.toFixed(5)}`,
        );
      } catch (error) {
        results.push({
          id: scenario.id,
          title: scenario.title,
          error: error instanceof Error ? error.message : String(error),
        } as ScenarioResult);
        log(
          `${scenario.id} ERROR ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  await Promise.all(conduit.connectionIds.map((id) => worker(id)));

  results.sort((a, b) => a.id.localeCompare(b.id));
  const summary = summarize(
    results,
    recorder,
    Date.now() - started,
    conduit.sourceLimits.dailyTokenLimit,
  );
  const payload = {
    generatedAt: new Date().toISOString(),
    config: {
      ...BENCH,
      model: 'claude-haiku-5-5',
      sourceLimits: conduit.sourceLimits,
      keepSourceLimits: process.env.BENCH_KEEP_SOURCE_LIMITS === 'true',
    },
    summary,
    results,
  };
  fs.writeFileSync(
    path.join(outDir, 'results.json'),
    JSON.stringify(payload, null, 1),
  );
  const markdown = renderSummary(summary, results);
  fs.writeFileSync(path.join(outDir, 'summary.md'), markdown);
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  process.stdout.write(`\n${markdown}\n`);
  log(`Resultados: ${outDir}`);

  await stack.stop();
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[bench] ERROR ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
