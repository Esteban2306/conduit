import type { MessageSpec } from './scenario-types';
import { ChildProcess, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BENCH, LEONICE_ROOT, pgUrl } from './bench.config';
import { isolatedEnv } from './isolated-env';
import { prepareInfra } from './infra';
import { instrumentAnthropic, recorder, track } from './recorder';
import type { ConduitBench } from './conduit-bench-app';
import type { WarmupLevel } from 'src/channels/whatsapp/baileys/BaileysRateLimiter';
import type {
  ToolCallOutcome,
  ToolCallRequest,
} from 'src/bot/tools/ToolExecutor.service';

export type { MessageSpec };

export interface BotRouterInternals {
  debouncer: { pending: Map<string, unknown> };
  respond: (...args: unknown[]) => Promise<void>;
}

export const ADMIN_PHONE = '573000000999';
export const log = (m: string) => process.stdout.write(`[bench] ${m}\n`);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function waMessage(phone: string, spec: MessageSpec) {
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

export async function startLeonice(
  conduit: {
    apiKey: string;
    toolApiKey: string;
    webhookSecret: string;
    connectionIds: string[];
    botId: string;
    integrationId: string;
    integrationSecret: string;
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
    CONDUIT_INTEGRATION_ID: conduit.integrationId,
    CONDUIT_INTEGRATION_SECRET: conduit.integrationSecret,
    CONDUIT_TOOLS_PUBLIC_URL: `http://127.0.0.1:${BENCH.leonicePort}/api/v1`,
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

export interface Stack {
  conduit: ConduitBench;
  router: {
    route: (
      messages: unknown[],
      botId: string,
      connectionId: string,
      tenantId: string,
    ) => Promise<void>;
  };
  internals: BotRouterInternals;
  contacts: {
    recordInbound: (connectionId: string, address: string) => Promise<void>;
  };
  leonice: (pathname: string, init?: RequestInit) => Promise<unknown>;
  stop: () => Promise<void>;
}

export interface StackOptions {
  pacing?: WarmupLevel;
  connections?: number;
}

export async function startStack(
  outDir: string,
  runtimeDir: string,
  options: StackOptions = {},
): Promise<Stack> {
  await prepareInfra(log);
  instrumentAnthropic();

  const { startConduit } = await import('./conduit-bench-app');
  const conduit = await startConduit(
    runtimeDir,
    path.join(outDir, 'conduit.log'),
    { pacing: options.pacing, connections: options.connections },
  );
  log(
    `Conduit de pruebas en :${BENCH.conduitPort} con ${conduit.connectionIds.length} conexiones simuladas`,
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
      failure:
        outcome.status === 'SUCCESS'
          ? undefined
          : {
              args: JSON.stringify(request.params).slice(0, 400),
              body: JSON.stringify(outcome.responseBody).slice(0, 400),
            },
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
  await conduit.refreshToolNames();
  const hookDeadline = Date.now() + 60_000;
  for (;;) {
    const { rows } = await conduit.db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM "ExternalVariable" WHERE "botConfigId" = $1',
      [conduit.botId],
    );
    if (Number(rows[0].n) > 0) break;
    if (Date.now() > hookDeadline)
      throw new Error(
        'El hook de información del negocio no llegó a Conduit en 60 s',
      );
    await sleep(500);
  }
  log(
    `Herramientas sembradas: ${conduit.toolNames.size}; hook del negocio recibido`,
  );
  const reasoning = process.env.BENCH_REASONING;
  const maxTokens = process.env.BENCH_MAX_TOKENS;
  if (reasoning || maxTokens) {
    await conduit.db.query(
      'UPDATE "BotAiSettings" SET "reasoningMode" = COALESCE($1::"ReasoningMode", "reasoningMode"), "maxTokensConversation" = COALESCE($2::int, "maxTokensConversation") WHERE "botConfigId" = $3',
      [reasoning ?? null, maxTokens ?? null, conduit.botId],
    );
    log(
      `Ajustes de la corrida: razonamiento=${reasoning ?? 'sembrado'}, maxTokens=${maxTokens ?? 'sembrado'}`,
    );
  }

  return {
    conduit,
    router: router as unknown as Stack['router'],
    internals,
    contacts: contacts as unknown as Stack['contacts'],
    leonice: (pathname, init) => leonice(pathname, init),
    stop: async () => {
      const exited = new Promise<void>((resolve) => {
        if (leoniceProcess.exitCode !== null) resolve();
        else leoniceProcess.once('exit', () => resolve());
      });
      leoniceProcess.kill('SIGTERM');
      await Promise.race([exited, sleep(10_000)]);
      if (leoniceProcess.exitCode === null) leoniceProcess.kill('SIGKILL');
      await Promise.race([conduit.close(), sleep(15_000)]);
    },
  };
}
