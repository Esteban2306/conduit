import * as fs from 'fs';
import * as path from 'path';
import { RESULTS_DIR } from './bench.config';
import { recorder } from './recorder';
import type { ScenarioResult } from './evaluate';
import { createRunner, Scenario } from './scenario-runner';
import { summarize } from './summary';
import { log, sleep, startStack } from './stack';
import { WarmupLevel } from 'src/channels/whatsapp/baileys/BaileysRateLimiter';

const num = (name: string, fallback: number) =>
  Number(process.env[name] ?? fallback);

const CONFIG = {
  clients: num('LOAD_CLIENTS', 30),
  rampSeconds: num('LOAD_RAMP_S', 120),
  thinkMinSeconds: num('LOAD_THINK_MIN_S', 8),
  thinkMaxSeconds: num('LOAD_THINK_MAX_S', 25),
  maxMinutes: num('LOAD_MAX_MIN', 25),
  warmup: (process.env.LOAD_WARMUP ?? 'NORMAL') as WarmupLevel,
  keepSourceLimits: process.env.BENCH_KEEP_SOURCE_LIMITS === 'true',
};

const pct = (values: number[], p: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ];
};

const dist = (values: number[]) => ({
  n: values.length,
  p50: pct(values, 50),
  p95: pct(values, 95),
  p99: pct(values, 99),
  max: values.length ? Math.max(...values) : 0,
});

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

interface Sample {
  tSeconds: number;
  started: number;
  finished: number;
  concurrentOps: number;
  conversationQueue: number;
  campaignQueue: number;
  delivered: number;
  llmCalls: number;
  usd: number;
  loopLagMaxMs: number;
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function logCounts(file: string): Record<string, number> {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  const probes: Record<string, RegExp> = {
    'conversación bloqueada por otro proceso': /bloqueada por otro proceso/g,
    'respuesta vacía de la IA': /Respuesta vacía de la IA/g,
    'IA no disponible': /IA no disponible para/g,
    'límite diario del modelo': /límite diario/g,
    'límite por minuto del modelo': /límite por minuto/g,
    'modelo en cooldown': /en cooldown/g,
    'respuesta duplicada': /Respuesta duplicada detectada/g,
    'dueño activo': /Dueño activo/g,
    'techo de conversación del limitador':
      /techo de seguridad de conversación/g,
    'errores (ERROR)': /\bERROR\b/g,
  };
  return Object.fromEntries(
    Object.entries(probes).map(([name, re]) => [
      name,
      (text.match(re) ?? []).length,
    ]),
  );
}

async function main(): Promise<void> {
  const started = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(RESULTS_DIR, `load-${stamp}`);
  const runtimeDir = path.join(outDir, 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });

  const spec = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'scenarios.json'), 'utf8'),
  ) as { scenarios: Scenario[] };
  const pool = spec.scenarios.filter((s) =>
    s.turns.every((t) => t.actor === 'A' && !t.concurrentWithPrevious),
  );

  log(
    `Carga: ${CONFIG.clients} clientas en ${CONFIG.rampSeconds} s, una sola conexión (${CONFIG.warmup}), tope ${CONFIG.maxMinutes} min`,
  );
  const stack = await startStack(outDir, runtimeDir, {
    pacing: CONFIG.warmup,
    connections: 1,
  });
  const { conduit } = stack;
  const connectionId = conduit.connectionIds[0];
  const runner = createRunner(stack, {
    settleTimeoutMs: CONFIG.maxMinutes * 60_000,
    thinkMs: [CONFIG.thinkMinSeconds * 1000, CONFIG.thinkMaxSeconds * 1000],
    graceMs: 2000,
  });

  const plan: Scenario[] = [];
  while (plan.length < CONFIG.clients) plan.push(...shuffled(pool));
  const clients = plan.slice(0, CONFIG.clients).map((s, i) => ({
    ...s,
    id: `c${String(i + 1).padStart(3, '0')}-${s.id}`,
  }));

  const loadStart = Date.now();
  const deadline = loadStart + CONFIG.maxMinutes * 60_000;
  const results: ScenarioResult[] = [];
  const unfinished = new Set(clients.map((c) => c.id));
  let startedClients = 0;
  const samples: Sample[] = [];
  let lagMax = 0;
  let lastTick = Date.now();
  const lagTimer = setInterval(() => {
    const now = Date.now();
    lagMax = Math.max(lagMax, now - lastTick - 100);
    lastTick = now;
  }, 100);
  const sampler = setInterval(() => {
    const depth = conduit.whatsappPlugin.queueDepth();
    samples.push({
      tSeconds: Math.round((Date.now() - loadStart) / 1000),
      started: startedClients,
      finished: results.length,
      concurrentOps: recorder.concurrent,
      conversationQueue: depth.conversation,
      campaignQueue: depth.campaign,
      delivered: recorder.sent.filter((s) => s.ctx).length,
      llmCalls: recorder.llm.length,
      usd: recorder.spentUsd,
      loopLagMaxMs: lagMax,
    });
    lagMax = 0;
  }, 5000);

  const runs = clients.map(async (client, index) => {
    const offset =
      (index / CONFIG.clients) * CONFIG.rampSeconds * 1000 +
      Math.random() * 1500;
    await sleep(offset);
    if (Date.now() > deadline) return;
    startedClients++;
    try {
      const result = await runner.runScenario(client, connectionId);
      results.push(result);
    } catch (error) {
      results.push({
        id: client.id,
        title: client.title,
        error: error instanceof Error ? error.message : String(error),
      } as ScenarioResult);
    } finally {
      unfinished.delete(client.id);
    }
  });

  const watchdog = sleep(CONFIG.maxMinutes * 60_000 + 180_000).then(
    () => 'timeout' as const,
  );
  const outcome = await Promise.race([
    Promise.allSettled(runs).then(() => 'done' as const),
    watchdog,
  ]);
  clearInterval(sampler);
  clearInterval(lagTimer);
  const finishedAt = Date.now();
  if (outcome === 'timeout')
    log(`Tiempo agotado: ${unfinished.size} clientas sin terminar`);

  const ran = results.filter((r) => r.turns);
  const iaTurns = ran.flatMap((r) => r.turns).filter((t) => t.route === 'IA');
  const replyLatency = ran
    .flatMap((r) => r.turns)
    .map((t) => t.latencyMs)
    .filter((v): v is number => typeof v === 'number');
  const conversationSends = recorder.sent.filter(
    (s) => s.ctx && s.channel === 'WHATSAPP',
  );
  const queueWait = conversationSends.map((s) => s.queuedMs ?? 0);
  const llmMs = recorder.llm.map((c) => c.ms);

  const scripted = new Map<string, Set<string>>();
  for (const client of clients) {
    const result = ran.find((r) => r.id === client.id);
    const phone = result?.turns[0]?.phone;
    if (!phone) continue;
    scripted.set(
      phone,
      new Set(
        client.turns
          .flatMap((t) =>
            t.messages.map((m) => m.text ?? m.image?.caption ?? ''),
          )
          .filter(Boolean),
      ),
    );
  }
  const inbound = await conduit.db.query<{ phone: string; content: string }>(
    `SELECT c."phoneNumber" AS phone, m.content FROM "BotMessage" m JOIN "Conversation" c ON c.id = m."conversationId" WHERE m.direction = 'INBOUND' AND c."phoneNumber" = ANY($1)`,
    [[...scripted.keys()]],
  );
  const crossTalk = inbound.rows.filter((row) => {
    const own = scripted.get(row.phone);
    return own
      ? row.content
          .split('\n')
          .some(
            (line) =>
              !own.has(line) && line !== '[imagen]' && line !== '[audio]',
          )
      : false;
  });
  const duplicatesInbound = (() => {
    const seen = new Map<string, number>();
    for (const row of inbound.rows)
      seen.set(
        `${row.phone}|${row.content}`,
        (seen.get(`${row.phone}|${row.content}`) ?? 0) + 1,
      );
    return [...seen.values()].filter((n) => n > 1).length;
  })();

  const flags: Record<string, number> = {};
  for (const r of ran)
    for (const t of r.turns)
      for (const f of t.flags ?? []) flags[f] = (flags[f] ?? 0) + 1;

  const conduitLog = path.join(outDir, 'conduit.log');
  const base = summarize(
    results,
    recorder,
    finishedAt - started,
    conduit.sourceLimits.dailyTokenLimit,
  );
  const durationMin = (finishedAt - loadStart) / 60_000;
  const metrics = {
    config: {
      ...CONFIG,
      dailyTokenLimit: CONFIG.keepSourceLimits
        ? conduit.sourceLimits.dailyTokenLimit
        : null,
    },
    clients: {
      planned: CONFIG.clients,
      started: startedClients,
      finished: ran.length,
      errors: results.filter((r) => r.error).length,
      unfinished: unfinished.size,
    },
    durationMinutes: durationMin,
    turns: { total: ran.flatMap((r) => r.turns).length, ia: iaTurns.length },
    delivered: conversationSends.length,
    repliesPerMinute: conversationSends.length / Math.max(0.1, durationMin),
    latencyMs: dist(replyLatency),
    limiterQueueWaitMs: dist(queueWait),
    llmCallMs: dist(llmMs),
    peakConcurrentOps: recorder.peakConcurrent,
    peakLimiterQueue: Math.max(0, ...samples.map((s) => s.conversationQueue)),
    eventLoopLagMaxMs: Math.max(0, ...samples.map((s) => s.loopLagMaxMs)),
    flags,
    isolation: {
      crossTalkMessages: crossTalk.length,
      duplicateInboundMessages: duplicatesInbound,
    },
    passRegular: base.passRegular,
    costUsd: recorder.spentUsd,
    costPerConversation: recorder.spentUsd / Math.max(1, ran.length),
    billableTokensPerConversation: base.perConversation.meanBillableTokens,
    logs: logCounts(conduitLog),
  };

  fs.writeFileSync(
    path.join(outDir, 'load.json'),
    JSON.stringify({ metrics, samples, results }, null, 1),
  );
  const m = metrics;
  const lines = [
    `# Prueba de carga: ${CONFIG.clients} clientas, una conexión (${CONFIG.warmup})`,
    ``,
    `| Métrica | Valor |`,
    `|---|---|`,
    `| Clientas planeadas / iniciadas / terminadas / sin terminar | ${m.clients.planned} / ${m.clients.started} / ${m.clients.finished} / ${m.clients.unfinished} |`,
    `| Duración | ${m.durationMinutes.toFixed(1)} min (rampa ${CONFIG.rampSeconds} s, pensar ${CONFIG.thinkMinSeconds}–${CONFIG.thinkMaxSeconds} s) |`,
    `| Turnos / con IA | ${m.turns.total} / ${m.turns.ia} |`,
    `| Respuestas entregadas | ${m.delivered} (${m.repliesPerMinute.toFixed(1)}/min) |`,
    `| Latencia mensaje→respuesta p50 / p95 / p99 / máx | ${sec(m.latencyMs.p50)} / ${sec(m.latencyMs.p95)} / ${sec(m.latencyMs.p99)} / ${sec(m.latencyMs.max)} |`,
    `| Espera en el limitador de WhatsApp p50 / p95 / máx | ${sec(m.limiterQueueWaitMs.p50)} / ${sec(m.limiterQueueWaitMs.p95)} / ${sec(m.limiterQueueWaitMs.max)} |`,
    `| Llamada al modelo p50 / p95 / máx | ${sec(m.llmCallMs.p50)} / ${sec(m.llmCallMs.p95)} / ${sec(m.llmCallMs.max)} |`,
    `| Operaciones de IA simultáneas (pico) | ${m.peakConcurrentOps} |`,
    `| Cola del limitador (pico) | ${m.peakLimiterQueue} mensajes |`,
    `| Retraso máximo del ciclo de eventos | ${m.eventLoopLagMaxMs} ms |`,
    `| Mezcla de chats (mensajes ajenos en una conversación) | ${m.isolation.crossTalkMessages} |`,
    `| Mensajes entrantes duplicados | ${m.isolation.duplicateInboundMessages} |`,
    `| Aciertos del banco bajo carga (sin fallos conocidos) | ${m.passRegular} |`,
    `| Banderas | ${
      Object.entries(flags)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ') || 'ninguna'
    } |`,
    `| Costo total / por conversación | $${m.costUsd.toFixed(4)} / $${m.costPerConversation.toFixed(5)} |`,
    `| Tokens que descuenta Conduit por conversación | ${m.billableTokensPerConversation} |`,
    ``,
    `Eventos en el registro de Conduit:`,
    ``,
    ...Object.entries(m.logs).map(([k, v]) => `- ${k}: ${v}`),
  ];
  fs.writeFileSync(path.join(outDir, 'load.md'), lines.join('\n'));
  process.stdout.write(`\n${lines.join('\n')}\n`);
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
