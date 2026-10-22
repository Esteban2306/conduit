import { ChildProcess, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BENCH, LEONICE_ROOT, RESULTS_DIR, pgUrl } from './bench.config';
import { isolatedEnv } from './isolated-env';
import { prepareInfra } from './infra';
import {
  instrumentAnthropic,
  recorder,
  track,
  turnStorage,
  TurnContext,
} from './recorder';
import { evaluateScenario, ScenarioResult, TurnResult } from './evaluate';
import { renderSummary, summarize } from './summary';
import type {
  ToolCallOutcome,
  ToolCallRequest,
} from 'src/bot/tools/ToolExecutor.service';

interface MessageSpec {
  text?: string;
  sticker?: boolean;
  audio?: boolean;
  reaction?: string;
  image?: { caption?: string };
}

interface TurnSpec {
  actor: string;
  messages: MessageSpec[];
  concurrentWithPrevious?: boolean;
  expect?: { route?: string };
}

export interface Scenario {
  id: string;
  category: string;
  title: string;
  knownFailure?: string;
  prior?: {
    client?: { name: string; birthDate: string };
    reservations?: unknown[];
  };
  turns: TurnSpec[];
  expect: ScenarioExpect;
}

export interface ScenarioExpect {
  route?: string;
  toolsAny?: string[];
  toolsAll?: string[];
  toolsForbidden?: string[];
  replyMatches?: string;
  replyNotMatches?: string;
  finalState?: { reservationStatus?: string; reservationCountAtLeast?: number };
  noFalseHumanPromise?: boolean;
  notCutOrEmpty?: boolean;
  noCrossTalk?: boolean;
  everyActorAnswered?: boolean;
}

interface BotRouterInternals {
  debouncer: { pending: Map<string, unknown> };
  respond: (...args: unknown[]) => Promise<void>;
}

const ADMIN_PHONE = '573000000999';
const BURST_GAP_MS = 1200;
const SETTLE_MS = 900;
const NOTIFICATION_GRACE_MS = 5000;

const log = (m: string) => process.stdout.write(`[bench] ${m}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waMessage(phone: string, spec: MessageSpec) {
  const content =
    spec.text !== undefined
      ? { conversation: spec.text }
      : spec.sticker
        ? { stickerMessage: { mimetype: 'image/webp' } }
        : spec.audio
          ? {
              audioMessage: {
                mimetype: 'audio/ogg; codecs=opus',
                seconds: 7,
                ptt: true,
              },
            }
          : spec.reaction
            ? { reactionMessage: { text: spec.reaction } }
            : {
                imageMessage: {
                  mimetype: 'image/jpeg',
                  caption: spec.image?.caption,
                  url: 'https://bench.invalid/image.jpg',
                },
              };
  return {
    key: {
      remoteJid: `${phone}@s.whatsapp.net`,
      fromMe: false,
      id: `BENCH${randomBytes(8).toString('hex').toUpperCase()}`,
    },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Bench',
    message: content,
  };
}

async function startLeonice(
  conduit: {
    apiKey: string;
    toolApiKey: string;
    webhookSecret: string;
    connectionIds: string[];
    botId: string;
  },
  logFile: string,
  runtimeDir: string,
): Promise<ChildProcess> {
  const env = isolatedEnv(LEONICE_ROOT, {
    NODE_ENV: 'development',
    PORT: String(BENCH.leonicePort),
    DATABASE_URL: pgUrl(BENCH.leoniceDb),
    REDIS_URL: `redis://127.0.0.1:${BENCH.redisPort}/${BENCH.leoniceRedisDb}`,
    BENCH_REDIS_PORT: String(BENCH.redisPort),
    JWT_SECRET: randomBytes(32).toString('hex'),
    JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
    CORS_ORIGIN: 'http://127.0.0.1:3999',
    THROTTLE_LIMIT: '1000',
    FRONTEND_ADMIN_URL: 'http://127.0.0.1:3999',
    SPA_PUBLIC_URL: 'http://127.0.0.1:3999',
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    CANCELLATION_LINK_SECRET: randomBytes(32).toString('hex'),
    CONDUIT_BASE_URL: `http://127.0.0.1:${BENCH.conduitPort}`,
    CONDUIT_API_KEY: conduit.apiKey,
    CONDUIT_TOOL_API_KEY: conduit.toolApiKey,
    CONDUIT_WEBHOOK_SECRET: conduit.webhookSecret,
    CONDUIT_WHATSAPP_CONNECTION_ID: conduit.connectionIds[0],
    CONDUIT_DEFAULT_BOT_ID: conduit.botId,
    CONDUIT_INTEGRATION_ID: 'bench-integration',
    CONDUIT_INTEGRATION_SECRET: randomBytes(16).toString('hex'),
    TS_NODE_PROJECT: path.join(LEONICE_ROOT, 'tsconfig.json'),
    TS_NODE_TRANSPILE_ONLY: 'true',
    TS_NODE_COMPILER_OPTIONS:
      '{"module":"commonjs","moduleResolution":"node","resolvePackageJsonExports":false}',
  });
  const out = fs.openSync(logFile, 'a');
  const child = spawn(
    process.execPath,
    [
      '-r',
      path.join(LEONICE_ROOT, 'node_modules/ts-node/register/transpile-only'),
      '-r',
      path.join(LEONICE_ROOT, 'node_modules/tsconfig-paths/register'),
      path.join(LEONICE_ROOT, 'test/bench/leonice-bench-server.ts'),
    ],
    { cwd: runtimeDir, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Leonice de pruebas no arrancó en 180 s')),
      180_000,
    );
    const onData = (chunk: Buffer) => {
      fs.writeSync(out, chunk);
      const text = chunk.toString();
      if (text.includes('BENCH_LEONICE_READY')) {
        clearTimeout(timer);
        resolve();
      }
      if (text.includes('BENCH_LEONICE_FAILED')) {
        clearTimeout(timer);
        reject(new Error(`Leonice de pruebas falló; ver ${logFile}`));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Leonice de pruebas salió con código ${code}; ver ${logFile}`,
        ),
      );
    });
  });
  child.removeAllListeners('exit');
  child.stdout.on('data', (c: Buffer) => fs.writeSync(out, c));
  child.stderr.on('data', (c: Buffer) => fs.writeSync(out, c));
  return child;
}

async function leonice(pathname: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(
    `http://127.0.0.1:${BENCH.leonicePort}${pathname}`,
    init,
  );
  if (!res.ok)
    throw new Error(`${pathname} → ${res.status} ${await res.text()}`);
  return (await res.json()) as unknown;
}

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

  await prepareInfra(log);
  instrumentAnthropic();

  const { startConduit } = await import('./conduit-bench-app');
  const conduit = await startConduit(
    runtimeDir,
    path.join(outDir, 'conduit.log'),
  );
  log(
    `Conduit de pruebas en :${BENCH.conduitPort} con ${conduit.connectionIds.length} conexiones simuladas y ${conduit.toolNames.size} herramientas`,
  );

  const { BotRouter } = await import('src/bot/router/BotRouter');
  const { ConversationSummarizer } =
    await import('src/bot/conversation/ConversationSummarizer');
  const { ToolExecutorService } =
    await import('src/bot/tools/ToolExecutor.service');
  const { WhatsAppContactService } =
    await import('src/channels/whatsapp/contacts/WhatsAppContactService');
  const router = conduit.app.get(BotRouter);
  const internals = router as unknown as BotRouterInternals;
  const contacts = conduit.app.get(WhatsAppContactService);
  track(internals, 'respond');
  track(conduit.app.get(ConversationSummarizer), 'refreshIfNeeded');
  const executor = conduit.app.get(ToolExecutorService);
  const callExecute = (request: ToolCallRequest) =>
    ToolExecutorService.prototype.execute.call(
      executor,
      request,
    ) as Promise<ToolCallOutcome>;
  executor.execute = async (request) => {
    const t0 = Date.now();
    const outcome = await callExecute(request);
    recorder.tools.push({
      ctx: recorder.ctx(),
      name:
        conduit.toolNames.get(request.toolDefinitionId) ??
        request.toolDefinitionId,
      status: outcome.status,
      httpStatus: outcome.httpStatus,
      ms: Date.now() - t0,
      errorDetail: outcome.errorDetail,
    });
    return outcome;
  };

  for (const connectionId of conduit.connectionIds)
    await contacts.recordInbound(connectionId, ADMIN_PHONE);

  const leoniceProcess = await startLeonice(
    conduit,
    path.join(outDir, 'leonice.log'),
    runtimeDir,
  );
  log(`Leonice de pruebas en :${BENCH.leonicePort}`);

  const debouncer = internals.debouncer;
  const pendingFor = (connectionId: string) =>
    [...debouncer.pending.keys()].some((k) => k.startsWith(connectionId));

  async function settle(
    scenarioId: string,
    connectionId: string,
  ): Promise<boolean> {
    const deadline = Date.now() + BENCH.turnTimeoutMs;
    let quietSince = 0;
    while (Date.now() < deadline) {
      const busy = recorder.busy(scenarioId) || pendingFor(connectionId);
      if (busy) quietSince = 0;
      else if (!quietSince) quietSince = Date.now();
      else if (Date.now() - quietSince >= SETTLE_MS) return true;
      await sleep(150);
    }
    return false;
  }

  let phoneCounter = 0;
  const nextPhone = () => `5730100${String(++phoneCounter).padStart(5, '0')}`;
  const results: ScenarioResult[] = [];
  const queue = [...scenarios];

  async function runScenario(
    scenario: Scenario,
    connectionId: string,
  ): Promise<ScenarioResult> {
    const phones = new Map<string, string>();
    const phoneOf = (actor: string) => {
      if (!phones.has(actor)) phones.set(actor, nextPhone());
      return phones.get(actor)!;
    };
    phoneOf('A');
    const prior = scenario.prior
      ? await leonice('/__bench/state', {
          method: 'POST',
          body: JSON.stringify({ phone: phoneOf('A'), ...scenario.prior }),
        })
      : null;

    const turns: TurnResult[] = [];
    const scenarioStart = Date.now();
    for (let i = 0; i < scenario.turns.length; i++) {
      const turn = scenario.turns[i];
      const phone = phoneOf(turn.actor);
      const ctx: TurnContext = {
        scenarioId: scenario.id,
        turn: i,
        actor: turn.actor,
      };
      const t0 = Date.now();
      await turnStorage.run(ctx, async () => {
        for (let m = 0; m < turn.messages.length; m++) {
          await contacts.recordInbound(connectionId, phone);
          if (connectionId !== conduit.connectionIds[0])
            await contacts.recordInbound(conduit.connectionIds[0], phone);
          await router.route(
            [waMessage(phone, turn.messages[m])],
            conduit.botId,
            connectionId,
            conduit.tenantId,
          );
          if (m < turn.messages.length - 1) await sleep(BURST_GAP_MS);
        }
      });
      const nextConcurrent = scenario.turns[i + 1]?.concurrentWithPrevious;
      const settled = nextConcurrent
        ? true
        : await settle(scenario.id, connectionId);
      turns.push({
        index: i,
        actor: turn.actor,
        phone,
        input: turn.messages,
        startedAt: t0,
        endedAt: Date.now(),
        settled,
        expect: turn.expect,
      });
    }
    await sleep(NOTIFICATION_GRACE_MS);

    const finalState: Record<string, unknown> = {};
    for (const [actor, phone] of phones)
      finalState[actor] = await leonice(`/__bench/inspect?phone=${phone}`);
    const inbound = await conduit.db.query<{ phone: string; content: string }>(
      `SELECT c."phoneNumber" AS phone, m.content FROM "BotMessage" m JOIN "Conversation" c ON c.id = m."conversationId"
       WHERE m.direction = 'INBOUND' AND c."phoneNumber" = ANY($1)`,
      [[...phones.values()]],
    );
    return evaluateScenario({
      scenario,
      phones,
      prior,
      turns,
      finalState,
      inbound: inbound.rows,
      adminPhone: ADMIN_PHONE,
      durationMs: Date.now() - scenarioStart,
    });
  }

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

  leoniceProcess.kill('SIGTERM');
  await conduit.close();
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `[bench] ERROR ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
