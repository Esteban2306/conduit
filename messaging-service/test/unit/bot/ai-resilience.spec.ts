import { AiModelRole, AiModelTier } from '@prisma/client';
import { AiErrorClassifier } from 'src/bot/ai/AiErrorClassifier';
import { AiModelSelectorService } from 'src/bot/ai/AiModelSelectorService';
import { AiOrchestrator } from 'src/bot/ai/AiOrchestrator';
import { AiErrorType } from 'src/bot/ai/interface/AiError';
import { TurnBudget } from 'src/bot/ai/turn-budget';
import { AiModelController } from 'src/bot/ai/AiModel.controller';
import { BotConfigService } from 'src/bot/config/BotConfigService';

type Row = Record<string, any>;

function row(id: string, priority: number, extra: Row = {}): Row {
  return {
    id,
    botConfigId: 'bot',
    provider: 'ANTHROPIC',
    model: `m-${id}`,
    apiKey: 'k',
    baseUrl: null,
    role: AiModelRole.CONVERSATION,
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

function fakePrisma(rows: Row[]) {
  const matches = (r: Row, where: Row = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('lte' in v) return r[k] <= v.lte;
        if ('in' in v) return v.in.includes(r[k]);
      }
      if (v instanceof Date) return r[k]?.getTime() === v.getTime();
      return r[k] === v;
    });
  const apply = (r: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) {
      r[k] =
        v && typeof v === 'object' && 'increment' in (v as Row)
          ? r[k] + (v as Row).increment
          : v;
    }
  };
  const find = (id: string) => rows.find((r) => r.id === id)!;
  return {
    rows,
    aiModelConfig: {
      findMany: async ({ where }: Row) =>
        rows
          .filter((r) => matches(r, where))
          .sort((a, b) => a.priority - b.priority)
          .map((r) => ({ ...r })),
      findUnique: async ({ where }: Row) => ({ ...find(where.id) }),
      update: async ({ where, data }: Row) => {
        await Promise.resolve();
        apply(find(where.id), data);
        return { ...find(where.id) };
      },
      updateMany: async ({ where, data }: Row) => {
        await Promise.resolve();
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => apply(r, data));
        return { count: hit.length };
      },
    },
  };
}

function world(
  rows: Row[],
  script: Record<string, Array<() => unknown>>,
  options: { retryAfterOn429?: number } = {},
) {
  const prisma = fakePrisma(rows);
  const selector = new AiModelSelectorService(
    prisma as never,
    {} as never,
    { open: (v: string) => v } as never,
  );
  jest
    .spyOn(selector, 'resolveApiKey')
    .mockImplementation(async () => 'sk-test-key-0000000000000000');
  const calls: string[] = [];
  const provider = {
    generateText: jest.fn(async (input: { model: string }) => {
      calls.push(input.model);
      const next = script[input.model]?.shift();
      if (!next) throw new Error('sin guion');
      const out = await next();
      return {
        content: 'ok',
        tokensUsed: 10,
        model: input.model,
        provider: 'ANTHROPIC',
        latencyMs: 1,
      };
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
  (orchestrator as unknown as { logger: object }).logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  (selector as unknown as { logger: object }).logger = { warn: jest.fn() };
  void options;
  const generate = (budget?: TurnBudget) =>
    orchestrator.generateResponse({
      botConfigId: 'bot',
      systemPrompt: 's',
      userMessage: 'hola',
      history: [],
      context: {} as never,
      budget,
    });
  return { prisma, selector, orchestrator, escalation, calls, generate };
}

const http = (status: number, headers?: Record<string, string>) => () => {
  throw Object.assign(new Error(`HTTP ${status}`), { status, headers });
};
const ok = () => undefined;

describe('Etapa 7: errores del proveedor', () => {
  it('401: la credencial queda inválida (no isActive=false), avisa una vez y responde con el respaldo', async () => {
    const w = world(
      [row('a', 1), row('b', 2, { role: AiModelRole.FALLBACK })],
      { 'm-a': [http(401)], 'm-b': [ok, ok] },
    );
    const first = await w.generate();
    expect(first.modelUsed).toBe('m-b');
    const a = w.prisma.rows[0];
    expect(a.isActive).toBe(true);
    expect(a.credentialInvalidAt).toBeInstanceOf(Date);
    expect(w.escalation.notifyAiCredentialInvalid).toHaveBeenCalledTimes(1);

    const second = await w.generate();
    expect(second.modelUsed).toBe('m-b');
    expect(w.calls.filter((m) => m === 'm-a')).toHaveLength(1);
    expect(w.escalation.notifyAiCredentialInvalid).toHaveBeenCalledTimes(1);
  });

  it('429 con retry-after: abre el circuito de inmediato, también para un modelo de pago, y respeta el plazo', async () => {
    const w = world(
      [row('a', 1), row('b', 2, { role: AiModelRole.FALLBACK })],
      { 'm-a': [http(429, { 'retry-after': '120' })], 'm-b': [ok, ok] },
    );
    await w.generate();
    const a = w.prisma.rows[0];
    const waitMs = a.unavailableUntil.getTime() - Date.now();
    expect(waitMs).toBeGreaterThan(110_000);
    expect(waitMs).toBeLessThanOrEqual(120_500);

    const again = await w.generate();
    expect(again.modelUsed).toBe('m-b');
    expect(w.calls.filter((m) => m === 'm-a')).toHaveLength(1);
  });

  it('529: reintenta una vez en el mismo modelo y luego usa el respaldo; a los 2 turnos fallidos abre el circuito', async () => {
    const w = world(
      [row('a', 1), row('b', 2, { role: AiModelRole.FALLBACK })],
      {
        'm-a': [http(529), http(529), http(529), http(529)],
        'm-b': [ok, ok, ok],
      },
    );
    const first = await w.generate();
    expect(first.modelUsed).toBe('m-b');
    expect(w.calls.filter((m) => m === 'm-a')).toHaveLength(2);
    expect(w.prisma.rows[0].consecutiveFailures).toBe(1);
    expect(w.prisma.rows[0].unavailableUntil).toBeNull();

    await w.generate();
    expect(w.prisma.rows[0].consecutiveFailures).toBe(2);
    expect(w.prisma.rows[0].unavailableUntil).toBeInstanceOf(Date);

    await w.generate();
    expect(w.calls.filter((m) => m === 'm-a')).toHaveLength(4);
  });

  it('un timeout no se reintenta en el mismo modelo y pasa al respaldo', async () => {
    const timeout = () => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    };
    const w = world(
      [row('a', 1), row('b', 2, { role: AiModelRole.FALLBACK })],
      { 'm-a': [timeout], 'm-b': [ok] },
    );
    const r = await w.generate();
    expect(r.modelUsed).toBe('m-b');
    expect(w.calls).toEqual(['m-a', 'm-b']);
  });

  it('un éxito cierra el circuito y borra los fallos', async () => {
    const w = world([row('a', 1, { consecutiveFailures: 1 })], {
      'm-a': [ok],
    });
    await w.generate();
    expect(w.prisma.rows[0].consecutiveFailures).toBe(0);
  });

  it('semiabierto: vencido el enfriamiento una sola llamada prueba el modelo aunque lleguen varias a la vez', async () => {
    const w = world(
      [
        row('a', 1, {
          consecutiveFailures: 2,
          unavailableUntil: new Date(Date.now() - 1_000),
        }),
      ],
      { 'm-a': [ok] },
    );
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        w.selector.selectModel('bot', AiModelRole.CONVERSATION),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it('todos caídos: lanza el error para que el bot responda con la plantilla en vez de callar', async () => {
    const w = world(
      [row('a', 1), row('b', 2, { role: AiModelRole.FALLBACK })],
      { 'm-a': [http(500), http(500)], 'm-b': [http(500), http(500)] },
    );
    await expect(w.generate()).rejects.toThrow(/Todos los modelos/);
    await expect(w.generate()).rejects.toThrow();
  });

  it('un modelo colgado no consume más que el presupuesto del turno', async () => {
    const hang = () => new Promise(() => undefined);
    const w = world(
      [row('a', 1), row('b', 2, { role: AiModelRole.FALLBACK })],
      { 'm-a': [hang], 'm-b': [ok] },
    );
    const started = Date.now();
    await expect(w.generate(new TurnBudget(300))).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('la prueba de reactivación deja la credencial inválida si el proveedor la rechaza', async () => {
    const w = world([row('a', 1)], { 'm-a': [http(401)] });
    const result = await w.orchestrator.probe(w.prisma.rows[0] as never);
    expect(result.ok).toBe(false);
    expect(w.prisma.rows[0].credentialInvalidAt).toBeInstanceOf(Date);
  });

  it('un modelo de pago respeta el enfriamiento; sus límites de tokens no aplican', async () => {
    const w = world(
      [
        row('a', 1, {
          dailyTokenLimit: 1,
          tokensUsedToday: 999,
          unavailableUntil: new Date(Date.now() + 60_000),
        }),
        row('b', 2, { dailyTokenLimit: 1, tokensUsedToday: 999 }),
      ],
      {},
    );
    const picked = await w.selector.selectModel(
      'bot',
      AiModelRole.CONVERSATION,
    );
    expect(picked?.id).toBe('b');
  });

  it('el reseteo de la ventana ocurre una sola vez y el consumo concurrente posterior no se pierde', async () => {
    const w = world(
      [
        row('a', 1, {
          tier: AiModelTier.FREE,
          dailyTokenLimit: 1_000_000,
          lastResetAt: new Date(Date.now() - 90_000_000),
          tokensUsedToday: 500,
        }),
      ],
      {},
    );
    await Promise.all([
      w.selector.selectModel('bot', AiModelRole.CONVERSATION),
      w.selector.selectModel('bot', AiModelRole.CONVERSATION),
    ]);
    expect(w.prisma.rows[0].tokensUsedToday).toBe(0);
    await Promise.all([
      ...Array.from({ length: 20 }, () => w.selector.recordUsage('a', 7)),
      w.selector.selectModel('bot', AiModelRole.CONVERSATION),
      w.selector.selectModel('bot', AiModelRole.CONVERSATION),
    ]);
    expect(w.prisma.rows[0].tokensUsedToday).toBe(140);
    expect(w.prisma.rows[0].requestsThisMinute).toBe(20);
  });

  it('clasifica 401, 429 con retry-after y 529', () => {
    const c = new AiErrorClassifier();
    expect(c.classify({ status: 401, message: 'x' }).type).toBe(
      AiErrorType.AUTHENTICATION,
    );
    expect(
      c.classify({ status: 429, headers: { 'retry-after': '7' } }).retryAfterMs,
    ).toBe(7000);
    expect(c.classify({ status: 529, message: 'x' }).type).toBe(
      AiErrorType.SERVER_ERROR,
    );
  });

  describe('Reactivar', () => {
    async function reactivate(script: Array<() => unknown>) {
      const w = world(
        [
          row('a', 1, {
            credentialInvalidAt: new Date(),
            consecutiveFailures: 3,
            unavailableUntil: new Date(Date.now() + 60_000),
          }),
        ],
        { 'm-a': script },
      );
      const config = new BotConfigService(
        w.prisma as never,
        {} as never,
        {} as never,
      );
      jest.spyOn(config, 'findOne').mockResolvedValue({} as never);
      const prismaForController = {
        aiModelConfig: {
          ...w.prisma.aiModelConfig,
          findFirst: async () => ({ id: 'a' }),
          findUniqueOrThrow: async ({ where }: Row) => ({
            ...w.prisma.rows.find((r) => r.id === where.id),
          }),
        },
      };
      (config as unknown as { prisma: unknown }).prisma = prismaForController;
      const controller = new AiModelController(
        config,
        w.orchestrator,
        prismaForController as never,
      );
      const result = await controller.reactivate('bot', 'a', {
        tenantId: 't',
      } as never);
      return { result, w };
    }

    it('restablece estado, cooldown y contadores y confirma con una llamada de prueba', async () => {
      const { result, w } = await reactivate([ok]);
      expect(result.reactivation).toEqual({ ok: true });
      const a = w.prisma.rows[0];
      expect(a.credentialInvalidAt).toBeNull();
      expect(a.unavailableUntil).toBeNull();
      expect(a.consecutiveFailures).toBe(0);
      expect(w.calls).toEqual(['m-a']);
    });

    it('si la credencial sigue mal, queda inválida otra vez y devuelve el motivo', async () => {
      const { result, w } = await reactivate([http(401)]);
      expect(result.reactivation.ok).toBe(false);
      expect(w.prisma.rows[0].credentialInvalidAt).toBeInstanceOf(Date);
    });
  });
});
