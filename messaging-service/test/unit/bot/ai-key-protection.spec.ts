import * as fs from 'fs';
import * as path from 'path';
import { NotFoundException } from '@nestjs/common';
import { AiProvider, AiModelRole, AiModelTier } from '@prisma/client';
import { BotConfigService } from 'src/bot/config/BotConfigService';
import { AiKeyEncryptionMigration } from 'src/bot/config/AiKeyEncryptionMigration';
import { AiModelSelectorService } from 'src/bot/ai/AiModelSelectorService';
import {
  SEALED_PREFIX,
  SecretEncryptionService,
} from 'src/shared/security/secret-encryption.service';
import {
  findSecrets,
  looksLikeSecret,
  maskError,
  maskSecrets,
} from 'src/shared/security/mask-secrets';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const REAL_KEY = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef-xyz9';
const OTHER_KEY = 'AIzaSyD-1234567890abcdefghijklmnopqrstuv';

function encryption(hexKey = KEY_A): SecretEncryptionService {
  const service = new SecretEncryptionService({
    get: () => hexKey,
  } as never);
  service.onModuleInit();
  return service;
}

type Row = Record<string, unknown>;

function pick(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return { ...row };
  return Object.fromEntries(
    Object.keys(select)
      .filter((k) => select[k])
      .map((k) => [k, row[k]]),
  );
}

function fakePrisma(models: Row[], bots: Row[]) {
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'NOT') {
        const [[field, cond]] = Object.entries(v as Row);
        const starts = (cond as { startsWith?: string }).startsWith;
        return !String(row[field]).startsWith(starts ?? '\u0000');
      }
      if (v && typeof v === 'object') return true;
      return row[k] === v;
    });
  const aiModelConfig = {
    create: jest.fn(
      ({ data, select }: { data: Row; select?: Record<string, boolean> }) => {
        const row = {
          id: 'new-model',
          isActive: true,
          tokensUsedToday: 0,
          createdAt: new Date(),
          ...data,
        };
        models.push(row);
        return Promise.resolve(pick(row, select));
      },
    ),
    findMany: jest.fn(
      ({ where, select }: { where?: Row; select?: Record<string, boolean> }) =>
        Promise.resolve(
          models.filter((m) => matches(m, where)).map((m) => pick(m, select)),
        ),
    ),
    findFirst: jest.fn(
      ({ where, select }: { where?: Row; select?: Record<string, boolean> }) =>
        Promise.resolve(
          models
            .filter((m) => matches(m, where))
            .map((m) => pick(m, select))[0] ?? null,
        ),
    ),
    update: jest.fn(
      ({
        where,
        data,
        select,
      }: {
        where: Row;
        data: Row;
        select?: Record<string, boolean>;
      }) => {
        const row = models.find((m) => matches(m, where))!;
        Object.assign(row, data);
        return Promise.resolve(pick(row, select));
      },
    ),
    updateMany: jest.fn(({ where, data }: { where: Row; data: Row }) => {
      const rows = models.filter((m) => matches(m, where));
      rows.forEach((r) => Object.assign(r, data));
      return Promise.resolve({ count: rows.length });
    }),
    delete: jest.fn(
      ({ where, select }: { where: Row; select?: Record<string, boolean> }) => {
        const index = models.findIndex((m) => matches(m, where));
        const [row] = models.splice(index, 1);
        return Promise.resolve(pick(row, select));
      },
    ),
  };
  const withModels = (bot: Row, args: { select?: Row; include?: Row }) => {
    const spec = (args.select?.aiModels ?? args.include?.aiModels) as
      | { where?: Row; select?: Record<string, boolean> }
      | undefined;
    const base = args.select
      ? pick(bot, args.select as Record<string, boolean>)
      : { ...bot };
    if (!spec) return base;
    return {
      ...base,
      aiModels: models
        .filter((m) => m.botConfigId === bot.id && matches(m, spec.where))
        .map((m) => pick(m, spec.select)),
    };
  };
  const botConfig = {
    findUnique: jest.fn((args: { where: Row; select?: Row; include?: Row }) => {
      const bot = bots.find(
        (b) =>
          b.id === args.where.id &&
          (!args.where.tenantId || b.tenantId === args.where.tenantId),
      );
      return Promise.resolve(bot ? withModels(bot, args) : null);
    }),
    findMany: jest.fn((args: { where: Row; select?: Row }) =>
      Promise.resolve(
        bots
          .filter((b) => b.tenantId === args.where.tenantId)
          .map((b) => withModels(b, args)),
      ),
    ),
    findFirst: jest.fn((args: { where: Row; select?: Row; include?: Row }) => {
      const bot = bots.find((b) => b.id === args.where.id);
      return Promise.resolve(bot ? withModels(bot, args) : null);
    }),
  };
  return { aiModelConfig, botConfig };
}

const BASE_MODEL = {
  provider: AiProvider.ANTHROPIC,
  model: 'claude-haiku-5-5',
  baseUrl: null,
  role: AiModelRole.CONVERSATION,
  tier: AiModelTier.FREE,
  priority: 1,
  isActive: true,
  dailyTokenLimit: 400000,
  minuteRequestLimit: 20,
  tokensUsedToday: 0,
  requestsThisMinute: 0,
  unavailableUntil: null,
  createdAt: new Date('2026-10-01'),
};

function world(storedKey: string) {
  const models: Row[] = [
    {
      id: 'm1',
      botConfigId: 'bot-1',
      apiKey: storedKey,
      apiKeyLast4: 'xyz9',
      ...BASE_MODEL,
    },
    {
      id: 'm-other',
      botConfigId: 'bot-2',
      apiKey: OTHER_KEY,
      apiKeyLast4: 'stuv',
      ...BASE_MODEL,
    },
  ];
  const bots: Row[] = [
    {
      id: 'bot-1',
      tenantId: 'tenant-1',
      name: 'Bot',
      status: 'ACTIVE',
      systemPrompt: '',
      clientApiBaseUrl: '',
      clientApiHeaders: {},
      intentEndpoints: {},
    },
    {
      id: 'bot-2',
      tenantId: 'tenant-2',
      name: 'Otro',
      status: 'ACTIVE',
      systemPrompt: '',
      clientApiBaseUrl: '',
      clientApiHeaders: {},
      intentEndpoints: {},
    },
  ];
  const prisma = fakePrisma(models, bots);
  const enc = encryption();
  const service = new BotConfigService(
    prisma as never,
    { get: jest.fn() } as never,
    enc,
  );
  return { prisma, service, models, enc };
}

describe('mask-secrets', () => {
  it.each([
    ['Anthropic', REAL_KEY],
    ['Google', OTHER_KEY],
    ['OpenAI', 'sk-abcdefghijklmnopqrstuvwxyz123456'],
    ['OpenRouter', 'sk-or-v1-abcdef1234567890abcdef'],
    ['Groq', 'gsk_abcdefghijklmnopqrstuvwxyz'],
    ['Bearer', 'Bearer abcdefghijklmnopqrstuvwxyz0123456789'],
    [
      'sellada',
      `${SEALED_PREFIX}aabbccddeeff00112233:aabbccddeeff00112233:aabbccdd`,
    ],
  ])('detecta y enmascara una clave %s', (_name, secret) => {
    expect(looksLikeSecret(secret)).toBe(true);
    const masked = maskSecrets(`Fallo 401 con ${secret} al llamar`);
    expect(masked).not.toContain(secret);
    expect(masked).toContain('[clave oculta]');
  });

  it('no toca texto normal ni identificadores', () => {
    const text =
      'Modelo claude-haiku-5-5 con 401 en el bot ea6cf0a6-15b2-42de-b4ff-988b8776b62d';
    expect(maskSecrets(text)).toBe(text);
    expect(looksLikeSecret('apiKeyLast4')).toBe(false);
  });

  it('maskError oculta la clave dentro del mensaje de un Error', () => {
    expect(
      maskError(new Error(`Incorrect API key provided: ${REAL_KEY}`)),
    ).not.toContain(REAL_KEY);
  });

  it('findSecrets reporta campos de secreto y valores con forma de clave, y acepta apiKeyLast4', () => {
    expect(
      findSecrets({
        id: 1,
        apiKeyLast4: 'xyz9',
        nested: [{ apiKey: 'x' }, { note: REAL_KEY }],
      }),
    ).toEqual([
      '$.nested[0].apiKey (campo de secreto)',
      '$.nested[1].note (valor con forma de clave)',
    ]);
    expect(findSecrets({ authorization: '••••' })).toEqual([]);
    expect(
      findSecrets({ id: 'm1', model: 'claude', apiKeyLast4: 'xyz9' }),
    ).toEqual([]);
  });
});

describe('SecretEncryptionService: claves selladas', () => {
  it('sella y abre; el valor guardado no contiene la clave y cada sellado es distinto', () => {
    const enc = encryption();
    const a = enc.seal(REAL_KEY);
    const b = enc.seal(REAL_KEY);
    expect(a.startsWith(SEALED_PREFIX)).toBe(true);
    expect(a).not.toContain(REAL_KEY);
    expect(a).not.toBe(b);
    expect(enc.open(a)).toBe(REAL_KEY);
    expect(enc.isSealed(a)).toBe(true);
    expect(enc.isSealed(REAL_KEY)).toBe(false);
  });

  it('abre un valor heredado en texto plano sin cambiarlo', () => {
    expect(encryption().open(REAL_KEY)).toBe(REAL_KEY);
  });

  it('con otra clave maestra o un valor alterado falla en vez de devolver basura', () => {
    const sealed = encryption(KEY_A).seal(REAL_KEY);
    expect(() => encryption(KEY_B).open(sealed)).toThrow();
    const tampered = `${sealed.slice(0, -2)}${sealed.endsWith('00') ? '11' : '00'}`;
    expect(() => encryption(KEY_A).open(tampered)).toThrow();
  });

  it('last4 devuelve los últimos 4 caracteres solo de claves con longitud razonable', () => {
    const enc = encryption();
    expect(enc.last4(`  ${REAL_KEY}  `)).toBe('xyz9');
    expect(enc.last4('corta')).toBeNull();
  });
});

describe('AiKeyEncryptionMigration', () => {
  it('cifra solo las claves en texto plano y conserva los últimos 4', async () => {
    const { prisma, enc, models } = world(REAL_KEY);
    models[0].apiKeyLast4 = null;
    models.push({
      id: 'm3',
      botConfigId: 'bot-1',
      apiKey: enc.seal('ya-cifrada-0123456789'),
      apiKeyLast4: '6789',
      ...BASE_MODEL,
    });
    const migration = new AiKeyEncryptionMigration(prisma as never, enc);

    expect(await migration.sealLegacyKeys()).toBe(2);
    expect(models.every((m) => enc.isSealed(String(m.apiKey)))).toBe(true);
    expect(enc.open(String(models[0].apiKey))).toBe(REAL_KEY);
    expect(models[0].apiKeyLast4).toBe('xyz9');
    expect(enc.open(String(models[2].apiKey))).toBe('ya-cifrada-0123456789');
  });

  it('es idempotente: una segunda corrida no toca nada ni vuelve a cifrar', async () => {
    const { prisma, enc, models } = world(REAL_KEY);
    const migration = new AiKeyEncryptionMigration(prisma as never, enc);
    await migration.sealLegacyKeys();
    const snapshot = models.map((m) => m.apiKey);
    prisma.aiModelConfig.updateMany.mockClear();

    expect(await migration.sealLegacyKeys()).toBe(0);
    expect(prisma.aiModelConfig.updateMany).not.toHaveBeenCalled();
    expect(models.map((m) => m.apiKey)).toEqual(snapshot);
  });

  it('si otra instancia cifró la fila entre la lectura y la escritura no la cifra dos veces', async () => {
    const { prisma, enc, models } = world(REAL_KEY);
    const original = prisma.aiModelConfig.findMany.getMockImplementation()!;
    prisma.aiModelConfig.findMany.mockImplementationOnce(
      async (args: never) => {
        const rows = await original(args);
        models[0].apiKey = enc.seal(REAL_KEY);
        return rows;
      },
    );
    const sealedByOther = String(models[0].apiKey);
    const migration = new AiKeyEncryptionMigration(prisma as never, enc);

    await migration.sealLegacyKeys();
    expect(enc.open(String(models[0].apiKey))).toBe(REAL_KEY);
    expect(String(models[0].apiKey).startsWith(SEALED_PREFIX)).toBe(true);
    expect(sealedByOther).toBeDefined();
  });

  it('un error al cifrar no impide arrancar y no registra la clave', async () => {
    const { prisma, enc } = world(REAL_KEY);
    prisma.aiModelConfig.findMany.mockRejectedValueOnce(new Error('db caída'));
    const migration = new AiKeyEncryptionMigration(prisma as never, enc);
    await expect(migration.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});

describe('BotConfigService: ninguna respuesta lleva la apiKey', () => {
  it('guarda la clave cifrada, con los últimos 4, y no la devuelve', async () => {
    const { service, prisma, enc } = world(REAL_KEY);
    const created = await service.addAiModel(
      'bot-1',
      {
        provider: AiProvider.ANTHROPIC,
        model: 'claude-haiku-5-5',
        apiKey: `  ${REAL_KEY} `,
        role: AiModelRole.CONVERSATION,
        tier: AiModelTier.FREE,
        priority: 2,
      } as never,
      'tenant-1',
    );
    const stored = prisma.aiModelConfig.create.mock.calls[0][0].data;
    expect(stored.apiKey).not.toContain(REAL_KEY);
    expect(enc.open(stored.apiKey)).toBe(REAL_KEY);
    expect(stored.apiKeyLast4).toBe('xyz9');
    expect(created).not.toHaveProperty('apiKey');
    expect(created).toHaveProperty('apiKeyLast4', 'xyz9');
    expect(findSecrets(created)).toEqual([]);
  });

  it.each([
    [
      'getAiModels',
      (s: BotConfigService) => s.getAiModels('bot-1', 'tenant-1'),
    ],
    [
      'resetModelCounters',
      (s: BotConfigService) => s.resetModelCounters('bot-1', 'm1', 'tenant-1'),
    ],
    ['findOne', (s: BotConfigService) => s.findOne('bot-1', 'tenant-1')],
    ['findAll', (s: BotConfigService) => s.findAll('tenant-1')],
    ['findOneForBot', (s: BotConfigService) => s.findOneForBot('bot-1')],
    ['getConfigById', (s: BotConfigService) => s.getConfigById('bot-1')],
    [
      'getConfigForRouting',
      (s: BotConfigService) => s.getConfigForRouting('bot-1', 'tenant-1'),
    ],
    [
      'removeAiModel',
      (s: BotConfigService) => s.removeAiModel('bot-1', 'm1', 'tenant-1'),
    ],
  ])('%s', async (_name, call) => {
    for (const stored of [REAL_KEY, encryption().seal(REAL_KEY)]) {
      const { service } = world(stored);
      const result = await call(service);
      expect(result).toBeTruthy();
      expect(findSecrets(result)).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(REAL_KEY);
      expect(JSON.stringify(result)).not.toContain(SEALED_PREFIX);
    }
  });

  it('reset y borrado de un modelo de otro bot responden 404 y no modifican nada (antes: IDOR)', async () => {
    const { service, prisma, models } = world(REAL_KEY);
    await expect(
      service.resetModelCounters('bot-1', 'm-other', 'tenant-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.removeAiModel('bot-1', 'm-other', 'tenant-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.aiModelConfig.update).not.toHaveBeenCalled();
    expect(prisma.aiModelConfig.delete).not.toHaveBeenCalled();
    expect(models).toHaveLength(2);
  });

  it('un bot de otro tenant no es accesible', async () => {
    const { service } = world(REAL_KEY);
    await expect(
      service.getAiModels('bot-2', 'tenant-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AiModelSelectorService.resolveApiKey', () => {
  function selector(enc = encryption()) {
    return new AiModelSelectorService(
      {} as never,
      { get: jest.fn() } as never,
      enc,
    );
  }
  const model = (apiKey: string) =>
    ({ id: 'm1', provider: 'ANTHROPIC', apiKey }) as never;

  afterEach(() => {
    delete process.env.ANTHROPIC_DEFAULT_API_KEY;
  });

  it('descifra una clave sellada y acepta una heredada en texto plano', async () => {
    const enc = encryption();
    expect(await selector(enc).resolveApiKey(model(enc.seal(REAL_KEY)))).toBe(
      REAL_KEY,
    );
    expect(await selector(enc).resolveApiKey(model(REAL_KEY))).toBe(REAL_KEY);
  });

  it('un placeholder sellado cae a la variable de entorno, sin mostrar su valor en el error', async () => {
    const enc = encryption();
    const placeholder = 'YOUR_ANTHROPIC_KEY_HERE';
    await expect(
      selector(enc).resolveApiKey(model(enc.seal(placeholder))),
    ).rejects.toThrow(/ANTHROPIC_DEFAULT_API_KEY/);
    await expect(
      selector(enc).resolveApiKey(model(enc.seal(placeholder))),
    ).rejects.not.toThrow(placeholder);
    process.env.ANTHROPIC_DEFAULT_API_KEY = REAL_KEY;
    expect(
      await selector(enc).resolveApiKey(model(enc.seal(placeholder))),
    ).toBe(REAL_KEY);
  });

  it('con la clave maestra equivocada el error explica la causa y no incluye ningún secreto', async () => {
    const sealed = encryption(KEY_A).seal(REAL_KEY);
    const error = await selector(encryption(KEY_B))
      .resolveApiKey(model(sealed))
      .catch((e: Error) => e);
    expect((error as Error).message).toMatch(/INTEGRATION_ENCRYPTION_KEY/);
    expect(findSecrets((error as Error).message)).toEqual([]);
    expect((error as Error).message).not.toContain(sealed);
  });
});

describe('Guardia estática: ninguna consulta de modelos devuelve filas crudas', () => {
  const SRC = path.resolve(__dirname, '../../../src');
  const CALL =
    /aiModelConfig\.(create|update|delete|findMany|findFirst|findUnique|upsert)\(/g;
  const ALLOWED_RAW = new Set(['bot/ai/AiModelSelectorService.ts']);

  function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
    });
  }

  function bodyFrom(text: string, openParen: number): string {
    let depth = 0;
    for (let i = openParen; i < text.length; i++) {
      if (text[i] === '(') depth++;
      if (text[i] === ')' && --depth === 0) return text.slice(openParen, i + 1);
    }
    return text.slice(openParen);
  }

  const files = walk(SRC).map((f) => ({
    rel: path.relative(SRC, f),
    text: fs.readFileSync(f, 'utf8'),
  }));

  it('cada consulta a aiModelConfig declara select (salvo el selector interno de modelos)', () => {
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      if (ALLOWED_RAW.has(rel)) continue;
      for (const match of text.matchAll(CALL)) {
        const open = match.index! + match[0].length - 1;
        const body = bodyFrom(text, open);
        const isWrite = match[1] === 'updateMany';
        if (!isWrite && !/\bselect\s*:/.test(body))
          offenders.push(`${rel}: aiModelConfig.${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('toda relación aiModels incluida en una consulta de bot declara select', () => {
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      for (const match of text.matchAll(/aiModels:\s*\{/g)) {
        const body = text.slice(match.index!, match.index! + 400);
        const block = body.slice(0, body.indexOf('}\n') + 1 || 400);
        if (!/select\s*:/.test(body.slice(0, 260)))
          offenders.push(`${rel}: ${block.replace(/\s+/g, ' ').slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ningún controlador ni servicio de configuración devuelve el campo apiKey en un select', () => {
    const offenders = files
      .filter(
        ({ rel }) =>
          rel.startsWith('bot/config/') ||
          rel.startsWith('bot/dto/') ||
          rel.startsWith('bot/admin/'),
      )
      .filter(({ rel }) => rel !== 'bot/config/AiKeyEncryptionMigration.ts')
      .filter(({ text }) => /select:\s*\{[^}]*\bapiKey\s*:\s*true/.test(text))
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});
