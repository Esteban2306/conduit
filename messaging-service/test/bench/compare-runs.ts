import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESULTS_DIR } from './bench.config';

interface Turn {
  route: string;
  llmCalls?: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number | null;
  flags?: string[];
}
interface Scenario {
  id: string;
  pass: boolean;
  costUsd: number;
  turns: Turn[];
}

const percentile = (values: number[], p: number): number => {
  const v = [...values].sort((a, b) => a - b);
  if (v.length === 0) return 0;
  const k = ((v.length - 1) * p) / 100;
  const f = Math.floor(k);
  const c = Math.min(f + 1, v.length - 1);
  return v[f] + (v[c] - v[f]) * (k - f);
};
const mean = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);

function load(dir: string): Scenario[] {
  const path = dir.includes('/') ? dir : join(RESULTS_DIR, dir);
  const raw = JSON.parse(readFileSync(join(path, 'results.json'), 'utf8')) as
    | Scenario[]
    | { results: Scenario[] };
  return Array.isArray(raw) ? raw : raw.results;
}

export function summarize(dirs: string[]) {
  const runs = dirs.map((dir) => {
    const items = load(dir);
    const turns = items.flatMap((i) => i.turns);
    const ai = turns.filter((t) => (t.llmCalls ?? 0) > 0);
    const answered = turns.filter(
      (t) => t.route !== 'ignorado' && t.latencyMs !== null,
    );
    const fresh = ai.map((t) => t.inputTokens - t.cacheReadTokens);
    const counted = items
      .filter((i) => i.turns.length > 0)
      .map((i) =>
        i.turns.reduce(
          (sum, t) =>
            sum +
            (t.inputTokens - t.cacheReadTokens) +
            t.outputTokens +
            0.1 * t.cacheReadTokens,
          0,
        ),
      );
    const costs = items.filter((i) => i.turns.length > 0).map((i) => i.costUsd);
    const flags = new Map<string, number>();
    for (const t of turns)
      for (const f of t.flags ?? []) flags.set(f, (flags.get(f) ?? 0) + 1);
    return {
      passed: items.filter((i) => i.pass).length,
      total: items.length,
      aiTurns: ai.length,
      noAiShare: 1 - ai.length / Math.max(turns.filter((t) => t.route !== 'ignorado').length, 1),
      inputP50: percentile(ai.map((t) => t.inputTokens), 50),
      inputP95: percentile(ai.map((t) => t.inputTokens), 95),
      freshP50: percentile(fresh, 50),
      freshP95: percentile(fresh, 95),
      cacheShare:
        ai.reduce((a, t) => a + t.cacheReadTokens, 0) /
        Math.max(ai.reduce((a, t) => a + t.inputTokens, 0), 1),
      outputP50: percentile(ai.map((t) => t.outputTokens), 50),
      costConvP50: percentile(costs, 50),
      costConvP95: percentile(costs, 95),
      costTotal: costs.reduce((a, b) => a + b, 0),
      latencyP50: percentile(answered.map((t) => t.latencyMs as number), 50),
      latencyP95: percentile(answered.map((t) => t.latencyMs as number), 95),
      countedPerConversation: mean(counted),
      truncated: flags.get('cortado') ?? 0,
      empty: (flags.get('vacío') ?? 0) + (flags.get('sin-respuesta') ?? 0),
    };
  });
  const avg = (pick: (r: (typeof runs)[number]) => number) => mean(runs.map(pick));
  return {
    runs: runs.length,
    passedPerRun: runs.map((r) => r.passed),
    total: runs[0]?.total ?? 0,
    aiTurns: avg((r) => r.aiTurns),
    noAiShare: avg((r) => r.noAiShare),
    inputP50: avg((r) => r.inputP50),
    inputP95: avg((r) => r.inputP95),
    freshP50: avg((r) => r.freshP50),
    freshP95: avg((r) => r.freshP95),
    cacheShare: avg((r) => r.cacheShare),
    outputP50: avg((r) => r.outputP50),
    costConvP50: avg((r) => r.costConvP50),
    costConvP95: avg((r) => r.costConvP95),
    costTotal: avg((r) => r.costTotal),
    latencyP50: avg((r) => r.latencyP50),
    latencyP95: avg((r) => r.latencyP95),
    countedPerConversation: avg((r) => r.countedPerConversation),
    truncated: runs.reduce((a, r) => a + r.truncated, 0),
    empty: runs.reduce((a, r) => a + r.empty, 0),
  };
}

if (require.main === module) {
  const groups: string[][] = [[]];
  for (const arg of process.argv.slice(2)) {
    if (arg === '--') groups.push([]);
    else groups[groups.length - 1].push(arg);
  }
  for (const [index, dirs] of groups.entries()) {
    if (dirs.length === 0) continue;
    console.log(`Grupo ${index + 1} (${dirs.length} corridas)`);
    console.log(JSON.stringify(summarize(dirs), null, 2));
  }
}
