import { randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { INestApplication } from '@nestjs/common';
import { parse as parseDotenv } from 'dotenv';
import { Client } from 'pg';
import { BENCH, CONDUIT_ROOT, pgUrl } from './bench.config';
import { applyToProcess, isolatedEnv } from './isolated-env';
import { FakeChannelPlugin, fakeSessionManager } from './fake-channel';
import type { WarmupLevel } from 'src/channels/whatsapp/baileys/BaileysRateLimiter';

export interface ConduitBench {
  app: INestApplication;
  tenantId: string;
  botId: string;
  connectionIds: string[];
  apiKey: string;
  toolApiKey: string;
  webhookSecret: string;
  toolNames: Map<string, string>;
  whatsappPlugin: FakeChannelPlugin;
  integrationId: string;
  integrationSecret: string;
  refreshToolNames: () => Promise<void>;
  sourceLimits: {
    dailyTokenLimit: number | null;
    minuteRequestLimit: number | null;
    tier: string | null;
  };
  db: Client;
  close: () => Promise<void>;
}

const BOT_TABLES = [
  'AiModelConfig',
  'BotAiSettings',
  'BotPromptTemplate',
  'BotEscalationContact',
];

export function prepareConduitEnv(runtimeDir: string): void {
  applyToProcess(
    isolatedEnv(CONDUIT_ROOT, {
      NODE_ENV: 'development',
      PORT: String(BENCH.conduitPort),
      API_SECRET_KEY: randomBytes(24).toString('hex'),
      FRONTEND_URL: 'http://127.0.0.1:3999',
      JWT_SECRET: randomBytes(32).toString('hex'),
      INTEGRATION_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      WEBHOOK_SIGNING_SECRET: randomBytes(24).toString('hex'),
      DATABASE_URL: pgUrl(BENCH.conduitDb),
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: String(BENCH.redisPort),
      DEFAULT_TENANT_ID: 'default',
      RESEND_FROM_EMAIL: 'bench@example.com',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '2525',
      SMTP_FROM_EMAIL: 'bench@example.com',
      WA_CHANNEL_MODE: 'baileys',
      WA_SESSION_PATH: path.join(runtimeDir, 'baileys_session'),
      WA_WARMUP_LEVEL: 'NORMAL',
      WA_TIMEZONE: 'America/Bogota',
      QUEUE_MAX_ATTEMPTS: '5',
      QUEUE_BACKOFF_DELAY: '120000',
    }),
  );
}

type Row = Record<string, unknown>;

async function readSource(): Promise<{
  rows: Record<string, Row[]>;
  tenant: Row;
  bot: Row;
  masterKey: string;
}> {
  const sourceEnv = parseDotenv(
    fs.readFileSync(path.join(CONDUIT_ROOT, '.env')),
  );
  const source = new Client({ connectionString: sourceEnv.DATABASE_URL });
  await source.connect();
  try {
    await source.query('SET default_transaction_read_only = on');
    const bot = (
      await source.query<{ r: Row }>(
        'SELECT row_to_json(b) AS r FROM "BotConfig" b WHERE id = $1',
        [BENCH.sourceBotId],
      )
    ).rows[0]?.r;
    if (!bot)
      throw new Error(
        `No existe el bot ${BENCH.sourceBotId} en la base de origen`,
      );
    const tenant = (
      await source.query<{ r: Row }>(
        'SELECT row_to_json(t) AS r FROM "Tenant" t WHERE id = $1',
        [bot.tenantId],
      )
    ).rows[0].r;
    const rows: Record<string, Row[]> = {};
    for (const table of BOT_TABLES) {
      rows[table] = (
        await source.query<{ r: Row }>(
          `SELECT row_to_json(x) AS r FROM "${table}" x WHERE "botConfigId" = $1`,
          [BENCH.sourceBotId],
        )
      ).rows.map((r) => r.r);
    }
    return {
      rows,
      tenant,
      bot,
      masterKey: sourceEnv.INTEGRATION_ENCRYPTION_KEY,
    };
  } finally {
    await source.end();
  }
}

async function insertRow(
  db: Client,
  table: string,
  row: unknown,
): Promise<void> {
  await db.query(
    `INSERT INTO "${table}" SELECT * FROM json_populate_record(NULL::"${table}", $1::json)`,
    [JSON.stringify(row)],
  );
}

export interface ConduitOptions {
  pacing?: WarmupLevel;
  connections?: number;
}

export async function startConduit(
  runtimeDir: string,
  logFile: string,
  options: ConduitOptions = {},
): Promise<ConduitBench> {
  prepareConduitEnv(runtimeDir);
  const source = await readSource();

  const { Test } = await import('@nestjs/testing');
  const { ValidationPipe } = await import('@nestjs/common');
  const { default: cookieParser } = await import('cookie-parser');
  const { AppModule } = await import('src/app.module');
  const { GlobalExceptionFilter } =
    await import('src/shared/filters/global-exception.filter');
  const { BaileysSessionManager } =
    await import('src/channels/whatsapp/baileys/BaileysSessionManager');
  const { BaileysPlugin } =
    await import('src/channels/whatsapp/baileys/BaileysPlugin');
  const { GmailResendPlugin } =
    await import('src/channels/email/resend/GmailResendPlugin');
  const { SmtpPlugin } =
    await import('src/channels/email/smtp/SmtpBrevoPlugin');
  const { SecretEncryptionService } =
    await import('src/shared/security/secret-encryption.service');
  const { ApiKeyService } = await import('src/auth/api/ApiKeyService');
  const { ExternalIntegrationService } =
    await import('src/external/integrations/ExternalIntegration.service');
  const sourceEncryption = new SecretEncryptionService({
    get: () => source.masterKey,
  } as never);
  sourceEncryption.onModuleInit();

  const log = fs.createWriteStream(logFile, { flags: 'a' });
  const write =
    (level: string) =>
    (message: unknown, ...rest: unknown[]) =>
      log.write(
        `${new Date().toISOString()} ${level} ${[message, ...rest].map(String).join(' ')}\n`,
      );
  const logger = {
    log: write('LOG'),
    warn: write('WARN'),
    error: write('ERROR'),
    debug: write('DEBUG'),
    verbose: write('VERBOSE'),
  };

  const whatsappPlugin = new FakeChannelPlugin(
    'WHATSAPP',
    'bench-whatsapp',
    options.pacing
      ? { level: options.pacing, timeZone: 'America/Bogota' }
      : undefined,
  );

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(BaileysSessionManager)
    .useValue(fakeSessionManager())
    .overrideProvider(BaileysPlugin)
    .useValue(whatsappPlugin)
    .overrideProvider(GmailResendPlugin)
    .useValue(new FakeChannelPlugin('EMAIL', 'bench-resend'))
    .overrideProvider(SmtpPlugin)
    .useValue(new FakeChannelPlugin('EMAIL', 'bench-smtp'))
    .setLogger(logger)
    .compile();

  const app = moduleRef.createNestApplication<INestApplication>({
    rawBody: true,
    logger,
  });
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.setGlobalPrefix('api/v1');
  await app.init();

  const db = new Client({ connectionString: pgUrl(BENCH.conduitDb) });
  await db.connect();

  const tenant = source.tenant as { id: string };
  await insertRow(db, 'Tenant', tenant);
  await insertRow(db, 'BotConfig', source.bot);

  const toolApiKey = randomBytes(24).toString('hex');
  const encryption = app.get(SecretEncryptionService);
  const leoniceBase = `http://127.0.0.1:${BENCH.leonicePort}`;
  const toolNames = new Map<string, string>();
  const sourceModel = (source.rows.AiModelConfig[0] ?? {}) as {
    dailyTokenLimit?: number | null;
    minuteRequestLimit?: number | null;
    tier?: string | null;
  };
  const sourceLimits = {
    dailyTokenLimit: sourceModel.dailyTokenLimit ?? null,
    minuteRequestLimit: sourceModel.minuteRequestLimit ?? null,
    tier: sourceModel.tier ?? null,
  };
  for (const table of BOT_TABLES) {
    for (const raw of source.rows[table]) {
      const row: Row = { ...raw };
      if (table === 'AiModelConfig') {
        const plainKey = sourceEncryption.open(String(row.apiKey));
        row.apiKey = encryption.seal(plainKey);
        row.apiKeyLast4 = encryption.last4(plainKey);
        Object.assign(row, {
          tokensUsedToday: 0,
          requestsThisMinute: 0,
          unavailableUntil: null,
          credentialInvalidAt: null,
          consecutiveFailures: 0,
          lastErrorType: null,
          lastErrorAt: null,
          lastResetAt: new Date().toISOString(),
          lastMinuteResetAt: new Date().toISOString(),
        });
        if (process.env.BENCH_KEEP_SOURCE_LIMITS !== 'true')
          Object.assign(row, {
            dailyTokenLimit: null,
            minuteRequestLimit: null,
          });
      }
      if (table === 'BotEscalationContact') row.connectionId = null;
      await insertRow(db, table, row);
    }
  }

  const connectionIds: string[] = [];
  for (let i = 0; i < (options.connections ?? BENCH.connections); i++) {
    const id = randomUUID();
    await db.query(
      `INSERT INTO "WhatsAppConnection" (id, "tenantId", "botConfigId", name, "phoneNumber", status, "warmupLevel", "campaignPolicy", "connectedAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, 'CONNECTED', 'NORMAL', 'INBOUND_ONLY', now(), now())`,
      [id, tenant.id, BENCH.sourceBotId, `bench-${i + 1}`, `57300000000${i}`],
    );
    connectionIds.push(id);
  }

  const integration = await app
    .get(ExternalIntegrationService)
    .create(source.bot.id as string, tenant.id, { name: 'bench-leonice' });
  const { key: apiKey } = await app
    .get(ApiKeyService)
    .create(tenant.id, 'bench-leonice');
  const webhookSecret = randomBytes(32).toString('hex');
  await db.query(
    `INSERT INTO "WebhookEndpoint" (id, "tenantId", url, events, secret, "isActive", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4::jsonb, $5, true, now(), now())`,
    [
      randomUUID(),
      tenant.id,
      `${leoniceBase}/api/v1/integrations/conduit/message-events`,
      JSON.stringify(['*']),
      webhookSecret,
    ],
  );

  await app.listen(BENCH.conduitPort, '127.0.0.1');

  return {
    app,
    tenantId: tenant.id,
    botId: BENCH.sourceBotId,
    connectionIds,
    apiKey,
    toolApiKey,
    webhookSecret,
    toolNames,
    whatsappPlugin,
    integrationId: integration.id,
    integrationSecret: integration.secret,
    refreshToolNames: async () => {
      const { rows } = await db.query<{ id: string; name: string }>(
        'SELECT id, name FROM "ToolDefinition"',
      );
      toolNames.clear();
      for (const row of rows) toolNames.set(row.id, row.name);
    },
    sourceLimits,
    db,
    close: async () => {
      await db.end().catch(() => undefined);
      await app.close().catch(() => undefined);
      log.end();
    },
  };
}
