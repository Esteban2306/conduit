import { IntentRepository } from 'src/bot/intent/IntentRepository.service';
import { SPA_SEEDS } from './fixture';

function build(existing: Array<{ key: string; handler: string }> = []) {
  const saved: any[] = [];
  const prisma = {
    botIntent: {
      findMany: jest.fn(() => Promise.resolve([])),
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(
          existing.find((e) => e.key === where.botConfigId_key.key) ?? null,
        ),
      ),
      upsert: jest.fn((args: any) => {
        saved.push(args);
        return Promise.resolve({
          id: 'i1',
          botConfigId: 'bot',
          key: args.create.key,
          mode: args.create.mode,
          version: 1,
          ...args.create,
        });
      }),
    },
    botAiSettings: {
      findUnique: jest.fn(() =>
        Promise.resolve({ agentName: 'Sofía', companyName: 'Leonice' }),
      ),
    },
  };
  const repo = new IntentRepository(
    prisma as never,
    { findOne: jest.fn(() => Promise.resolve({})) } as never,
    { get: () => 'America/Bogota' } as never,
  );
  (repo as unknown as { logger: object }).logger = {
    warn: jest.fn(),
    error: jest.fn(),
  };
  return { repo, prisma, saved };
}

const template = {
  name: 'Promo',
  handler: 'TEMPLATE',
  patterns: ['^promo$'],
  variants: { default: ['Hola {{agente}}'] },
};

describe('IntentRepository', () => {
  it('guarda una definición válida; una intención nueva nace en SOMBRA', async () => {
    const { repo, saved } = build();
    const out = await repo.upsert('bot', 't', 'promo', template);
    expect(saved[0].create.mode).toBe('SHADOW');
    expect(out.key).toBe('promo');
  });

  it('rechaza definiciones inválidas con la lista de problemas', async () => {
    const { repo, saved } = build();
    await expect(
      repo.upsert('bot', 't', 'promo', { ...template, patterns: ['(a+)+$'] }),
    ).rejects.toMatchObject({ response: { problems: expect.any(Array) } });
    expect(saved).toHaveLength(0);
  });

  it('fallbackTo debe apuntar a una intención LLM_SLIM existente', async () => {
    const seed = SPA_SEEDS.find((s) => s.key === 'treatment_info');
    const { lockedMode, ...definition } = seed;
    void lockedMode;
    const missing = build();
    await expect(
      missing.repo.upsert('bot', 't', 'treatment_info', definition),
    ).rejects.toThrow(/fallbackTo/);

    const wrong = build([{ key: 'treatment_question', handler: 'TEMPLATE' }]);
    await expect(
      wrong.repo.upsert('bot', 't', 'treatment_info', definition),
    ).rejects.toThrow(/fallbackTo/);

    const ok = build([{ key: 'treatment_question', handler: 'LLM_SLIM' }]);
    await expect(
      ok.repo.upsert('bot', 't', 'treatment_info', definition),
    ).resolves.toBeDefined();
  });

  it('forBot arma el conjunto con identidad, modo por clave y sin las apagadas', async () => {
    const { repo, prisma } = build();
    (prisma.botIntent.findMany as jest.Mock).mockResolvedValueOnce([
      {
        id: '1',
        key: 'a',
        name: 'A',
        description: '',
        handler: 'TEMPLATE',
        mode: 'ACTIVE',
        priority: 1,
        patterns: ['^a$'],
        denyPatterns: [],
        maxTokens: 5,
        respectsOpenFlow: false,
        allowsQuestion: true,
        negationOk: false,
        fixedConfidence: null,
        aiClassifiable: false,
        config: {},
        variants: { default: ['x'] },
        cooldownSeconds: 0,
        schedule: null,
        notes: null,
        version: 1,
      },
      {
        id: '2',
        key: 'b',
        name: 'B',
        description: '',
        handler: 'TEMPLATE',
        mode: 'OFF',
        priority: 2,
        patterns: ['^b$'],
        denyPatterns: [],
        maxTokens: 5,
        respectsOpenFlow: false,
        allowsQuestion: true,
        negationOk: false,
        fixedConfidence: null,
        aiClassifiable: false,
        config: {},
        variants: { default: ['x'] },
        cooldownSeconds: 0,
        schedule: null,
        notes: null,
        version: 1,
      },
    ]);
    const set = await repo.forBot('bot');
    expect(set.compiled.map((c) => c.record.key)).toEqual(['a']);
    expect(set.modeOf('a')).toBe('ACTIVE');
    expect(set.modeOf('desconocida')).toBe('SHADOW');
    expect(set.agent).toBe('Sofía');
    await repo.forBot('bot');
    expect(prisma.botIntent.findMany).toHaveBeenCalledTimes(1);
  });

  it('si la tabla no existe (migración pendiente) no rompe: no clasifica', async () => {
    const { repo, prisma } = build();
    (prisma.botIntent.findMany as jest.Mock).mockRejectedValueOnce(
      new Error('relation does not exist'),
    );
    const set = await repo.forBot('bot');
    expect(set.compiled).toEqual([]);
  });
});
