import { AiModelRole, AiModelTier } from '@prisma/client';
import { AiModelSelectorService } from 'src/bot/ai/AiModelSelectorService';

type Row = Record<string, any>;
type Query = { where: Row; data: Row };

function row(id: string, priority: number, extra: Row = {}): Row {
  return {
    id,
    botConfigId: 'bot',
    specialistId: null,
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

function build(rows: Row[]) {
  const matches = (r: Row, where: Row = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (v instanceof Date) {
        return (r[k] as Date | null)?.getTime() === v.getTime();
      }
      if (v && typeof v === 'object' && 'lte' in v) {
        return (r[k] as Date) <= (v as { lte: Date }).lte;
      }
      return r[k] === v;
    });
  const apply = (r: Row, data: Row) => Object.assign(r, data);
  const prisma = {
    aiModelConfig: {
      findMany: ({ where }: Pick<Query, 'where'>) =>
        Promise.resolve(
          rows
            .filter((r) => matches(r, where))
            .sort((a, b) => a.priority - b.priority)
            .map((r) => ({ ...r })),
        ),
      findUnique: ({ where }: Pick<Query, 'where'>) =>
        Promise.resolve({ ...rows.find((r) => r.id === where.id) }),
      updateMany: ({ where, data }: Query) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => apply(r, data));
        return Promise.resolve({ count: hit.length });
      },
    },
  };
  const selector = new AiModelSelectorService(
    prisma as never,
    {} as never,
    {} as never,
  );
  return { selector, rows };
}

const CONVERSATION = AiModelRole.CONVERSATION;
const FALLBACK = AiModelRole.FALLBACK;

describe('AiModelSelectorService.selectModel (red de seguridad de la fase 3a)', () => {
  it('elige por prioridad ascendente dentro del rol pedido', async () => {
    const { selector } = build([row('b', 2), row('a', 1), row('c', 3)]);
    expect((await selector.selectModel('bot', CONVERSATION))?.id).toBe('a');
  });

  it('no mezcla roles: un modelo de otro rol no se elige', async () => {
    const { selector } = build([
      row('img', 1, { role: AiModelRole.IMAGE_ANALYSIS }),
      row('conv', 2),
    ]);
    expect((await selector.selectModel('bot', CONVERSATION))?.id).toBe('conv');
    expect(
      (await selector.selectModel('bot', AiModelRole.IMAGE_ANALYSIS))?.id,
    ).toBe('img');
  });

  it('descarta modelos inactivos y con credencial inválida', async () => {
    const { selector } = build([
      row('off', 1, { isActive: false }),
      row('bad', 2, { credentialInvalidAt: new Date() }),
      row('ok', 3),
    ]);
    expect((await selector.selectModel('bot', CONVERSATION))?.id).toBe('ok');
  });

  it('respeta la lista de exclusión', async () => {
    const { selector } = build([row('a', 1), row('b', 2)]);
    expect(
      (await selector.selectModel('bot', CONVERSATION, new Set(['a'])))?.id,
    ).toBe('b');
  });

  it('cae al rol FALLBACK cuando no queda ninguno del rol pedido', async () => {
    const { selector } = build([row('fb', 1, { role: FALLBACK })]);
    expect((await selector.selectModel('bot', CONVERSATION))?.id).toBe('fb');
  });

  it('el FALLBACK también aplica a otros roles, como el análisis de imagen', async () => {
    const { selector } = build([row('fb', 1, { role: FALLBACK })]);
    expect(
      (await selector.selectModel('bot', AiModelRole.IMAGE_ANALYSIS))?.id,
    ).toBe('fb');
  });

  it('devuelve null cuando no hay ningún modelo utilizable', async () => {
    const { selector } = build([row('a', 1, { isActive: false })]);
    expect(await selector.selectModel('bot', CONVERSATION)).toBeNull();
    expect(await selector.selectModel('bot', FALLBACK)).toBeNull();
  });

  it('aísla por dueño: los modelos de otro bot nunca se eligen', async () => {
    const { selector } = build([
      row('ajeno', 1, { botConfigId: 'otro-bot' }),
      row('propio', 2),
    ]);
    expect((await selector.selectModel('bot', CONVERSATION))?.id).toBe(
      'propio',
    );
    expect(await selector.selectModel('sin-modelos', CONVERSATION)).toBeNull();
  });

  it('un circuito abierto salta al siguiente modelo', async () => {
    const { selector } = build([
      row('a', 1, { unavailableUntil: new Date(Date.now() + 60_000) }),
      row('b', 2),
    ]);
    expect((await selector.selectModel('bot', CONVERSATION))?.id).toBe('b');
  });

  it('un modelo gratuito sin cupo diario se salta; uno de pago no tiene ese límite', async () => {
    const { selector } = build([
      row('free', 1, {
        tier: AiModelTier.FREE,
        dailyTokenLimit: 100,
        tokensUsedToday: 100,
      }),
      row('paid', 2, { dailyTokenLimit: 1, tokensUsedToday: 999 }),
    ]);
    expect((await selector.selectModel('bot', CONVERSATION))?.id).toBe('paid');
  });

  it('un modelo gratuito sin cupo por minuto se salta', async () => {
    const { selector } = build([
      row('free', 1, {
        tier: AiModelTier.FREE,
        minuteRequestLimit: 5,
        requestsThisMinute: 5,
      }),
      row('next', 2),
    ]);
    expect((await selector.selectModel('bot', CONVERSATION))?.id).toBe('next');
  });

  it('un modelo gratuito con cupo disponible se elige', async () => {
    const { selector } = build([
      row('free', 1, {
        tier: AiModelTier.FREE,
        dailyTokenLimit: 100,
        tokensUsedToday: 10,
        minuteRequestLimit: 5,
        requestsThisMinute: 1,
      }),
    ]);
    expect((await selector.selectModel('bot', CONVERSATION))?.id).toBe('free');
  });

  describe('dueño especialista', () => {
    const owned = (id: string, priority: number, extra: Row = {}) =>
      row(id, priority, { botConfigId: null, specialistId: 'esp', ...extra });

    it('un especialista elige solo sus modelos', async () => {
      const { selector } = build([row('del-bot', 1), owned('suyo', 2)]);
      expect(
        (await selector.selectModel({ specialistId: 'esp' }, CONVERSATION))?.id,
      ).toBe('suyo');
    });

    it('un bot nunca ve los modelos de un especialista', async () => {
      const { selector } = build([owned('suyo', 1)]);
      expect(await selector.selectModel('bot', CONVERSATION)).toBeNull();
    });

    it('el FALLBACK del especialista conserva el dueño y no usa los del bot', async () => {
      const { selector } = build([
        row('fb-bot', 1, { role: FALLBACK }),
        owned('fb-esp', 2, { role: FALLBACK }),
      ]);
      expect(
        (await selector.selectModel({ specialistId: 'esp' }, CONVERSATION))?.id,
      ).toBe('fb-esp');
    });

    it('sin modelos propios un especialista no cae a los del bot', async () => {
      const { selector } = build([row('del-bot', 1)]);
      expect(
        await selector.selectModel({ specialistId: 'esp' }, CONVERSATION),
      ).toBeNull();
    });

    it('otro especialista tampoco comparte modelos', async () => {
      const { selector } = build([owned('suyo', 1)]);
      expect(
        await selector.selectModel({ specialistId: 'otro' }, CONVERSATION),
      ).toBeNull();
    });
  });
});
