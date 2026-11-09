import { AiModelRole, AiModelTier } from '@prisma/client';
import { AiErrorClassifier } from 'src/bot/ai/AiErrorClassifier';
import { AiModelSelectorService } from 'src/bot/ai/AiModelSelectorService';
import { AiOrchestrator } from 'src/bot/ai/AiOrchestrator';

type Row = Record<string, any>;

function row(id: string, priority: number, extra: Row = {}): Row {
  return {
    id,
    botConfigId: null,
    specialistId: 'esp',
    provider: 'ANTHROPIC',
    model: `m-${id}`,
    apiKey: 'k',
    baseUrl: null,
    role: AiModelRole.IMAGE_ANALYSIS,
    tier: AiModelTier.PAID,
    priority,
    isActive: true,
    dailyTokenLimit: null,
    minuteRequestLimit: null,
    tokensUsedToday: 0,
    requestsThisMinute: 0,
    lastResetAt: new Date(),
    lastMinuteResetAt: new Date(),
    unavailableUntil: null,
    credentialInvalidAt: null,
    consecutiveFailures: 0,
    lastErrorType: null,
    lastErrorAt: null,
    ...extra,
  };
}

function build(rows: Row[], fail: Record<string, number> = {}) {
  const matches = (r: Row, where: Row = {}) =>
    Object.entries(where).every(([k, v]) => r[k] === v);
  const prisma = {
    aiModelConfig: {
      findMany: ({ where }: { where: Row }) =>
        Promise.resolve(
          rows
            .filter((r) => matches(r, where))
            .sort((a, b) => a.priority - b.priority)
            .map((r) => ({ ...r })),
        ),
      findUnique: ({ where }: { where: Row }) =>
        Promise.resolve({ ...rows.find((r) => r.id === where.id) }),
      update: ({ where, data }: { where: Row; data: Row }) => {
        const target = rows.find((r) => r.id === where.id) as Row;
        for (const [k, v] of Object.entries(data) as Array<[string, unknown]>) {
          target[k] =
            v && typeof v === 'object' && 'increment' in (v as Row)
              ? (target[k] as number) + (v as { increment: number }).increment
              : v;
        }
        return Promise.resolve({ ...target });
      },
      updateMany: () => Promise.resolve({ count: 1 }),
    },
  };
  const selector = new AiModelSelectorService(
    prisma as never,
    {} as never,
    { open: (v: string) => v } as never,
  );
  jest
    .spyOn(selector, 'resolveApiKey')
    .mockResolvedValue('sk-test-key-0000000000000000');
  const seen: Array<{
    model: string;
    botConfigId?: string;
    maxTokens?: number;
  }> = [];
  const provider = {
    analyzeImage: jest.fn((input: { model: string; maxTokens?: number }) => {
      seen.push(input);
      if (fail[input.model]) {
        throw Object.assign(new Error('HTTP 500'), { status: 500 });
      }
      return Promise.resolve({
        content: '{}',
        tokensUsed: 5,
        model: input.model,
        provider: 'ANTHROPIC',
        latencyMs: 1,
      });
    }),
  };
  const escalation = {
    notifyAiCredentialInvalid: jest.fn().mockResolvedValue(true),
  };
  const orchestrator = new AiOrchestrator(
    selector,
    { getProvider: () => provider } as never,
    new AiErrorClassifier(),
    escalation as never,
  );
  const silent = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  (orchestrator as unknown as { logger: object }).logger = silent;
  (selector as unknown as { logger: object }).logger = silent;
  return { orchestrator, seen, escalation };
}

const image = {
  prompt: 'p',
  systemPrompt: 's',
  imageBuffer: Buffer.from('x'),
  mimeType: 'image/jpeg',
};

describe('AiOrchestrator.analyzeImageForSpecialist', () => {
  it('usa el modelo propio del especialista', async () => {
    const { orchestrator, seen } = build([
      row('suyo', 1),
      row('del-bot', 1, { botConfigId: 'bot', specialistId: null }),
    ]);

    const result = await orchestrator.analyzeImageForSpecialist('esp', image);

    expect(result.modelConfigId).toBe('suyo');
    expect(seen.map((s) => s.model)).toEqual(['m-suyo']);
  });

  it('no manda botConfigId al proveedor y usa 1024 tokens por defecto', async () => {
    const { orchestrator, seen } = build([row('suyo', 1)]);

    await orchestrator.analyzeImageForSpecialist('esp', image);

    expect(seen[0].botConfigId).toBeUndefined();
    expect(seen[0].maxTokens).toBe(1024);
  });

  it('respeta el máximo de tokens pedido', async () => {
    const { orchestrator, seen } = build([row('suyo', 1)]);

    await orchestrator.analyzeImageForSpecialist('esp', {
      ...image,
      maxTokens: 300,
    });

    expect(seen[0].maxTokens).toBe(300);
  });

  it('sin modelos propios falla aunque el bot tenga los suyos', async () => {
    const { orchestrator, seen } = build([
      row('del-bot', 1, { botConfigId: 'bot', specialistId: null }),
    ]);

    await expect(
      orchestrator.analyzeImageForSpecialist('esp', image),
    ).rejects.toThrow(/Sin modelos disponibles/);
    expect(seen).toHaveLength(0);
  });

  it('cae al FALLBACK del mismo especialista y nunca a los del bot', async () => {
    const { orchestrator, seen } = build(
      [
        row('principal', 1),
        row('respaldo', 2, { role: AiModelRole.FALLBACK }),
        row('fb-bot', 1, {
          botConfigId: 'bot',
          specialistId: null,
          role: AiModelRole.FALLBACK,
        }),
      ],
      { 'm-principal': 1 },
    );

    const result = await orchestrator.analyzeImageForSpecialist('esp', image);

    expect(result.modelConfigId).toBe('respaldo');
    expect(seen.map((s) => s.model)).toContain('m-respaldo');
    expect(seen.map((s) => s.model)).not.toContain('m-fb-bot');
  });

  it('si fallan todos sus modelos no toca los del bot ni avisa a ningún bot', async () => {
    const { orchestrator, seen, escalation } = build(
      [
        row('principal', 1),
        row('fb-bot', 1, {
          botConfigId: 'bot',
          specialistId: null,
          role: AiModelRole.FALLBACK,
        }),
      ],
      { 'm-principal': 1, 'm-fb-bot': 1 },
    );

    await expect(
      orchestrator.analyzeImageForSpecialist('esp', image),
    ).rejects.toThrow();
    expect(seen.map((s) => s.model)).not.toContain('m-fb-bot');
    expect(escalation.notifyAiCredentialInvalid).not.toHaveBeenCalled();
  });
});

describe('AiOrchestrator.analyzeImage del bot (sin cambios)', () => {
  it('sigue eligiendo los modelos del bot y no los de un especialista', async () => {
    const { orchestrator, seen } = build([
      row('suyo', 1),
      row('del-bot', 1, { botConfigId: 'bot', specialistId: null }),
    ]);

    const result = await orchestrator.analyzeImage({
      ...image,
      botConfigId: 'bot',
    });

    expect(result.modelConfigId).toBe('del-bot');
    expect(seen.map((s) => s.model)).toEqual(['m-del-bot']);
  });
});
