jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
}));

import { BotRouter } from 'src/bot/router/BotRouter';

type Verdict = 'VALID' | 'INVALID' | 'NEEDS_REVIEW' | 'ERROR';

function harness(
  outcome: Record<string, unknown> | Error,
  options: { alertFails?: boolean } = {},
) {
  const botEscalation = {
    notifyVerificationReview: jest.fn(() =>
      options.alertFails
        ? Promise.reject(new Error('sin contactos'))
        : Promise.resolve(true),
    ),
  };
  const router = Object.create(BotRouter.prototype) as Record<string, unknown>;
  router.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  router.imageAnalysisService = {
    downloadOriginal: jest.fn(() => Promise.resolve(Buffer.from('img'))),
    analyzeBuffer: jest.fn(() => Promise.resolve({ status: 'ERROR' as const })),
    analyzeFromMessage: jest.fn(() =>
      Promise.resolve({ status: 'ERROR' as const }),
    ),
  };
  router.imagePrefetch = { downloadTimeoutMs: () => 10_000 };
  const bindingMode =
    outcome instanceof Error
      ? 'ACTIVE'
      : ((outcome.mode as string) ?? 'ACTIVE');
  router.specialistRuntime = {
    findBindings: jest.fn(() =>
      Promise.resolve([
        {
          capability: 'image-analysis',
          mode: bindingMode === 'SHADOW' ? 'SHADOW' : 'ACTIVE',
          timeoutMs: 12000,
        },
      ]),
    ),
    run: jest.fn(() =>
      outcome instanceof Error
        ? Promise.reject(outcome)
        : Promise.resolve(outcome),
    ),
  };
  router.conversationService = {
    updateContext: jest.fn(() => Promise.resolve()),
  };
  router.botEscalation = botEscalation;
  const target = router as unknown as {
    buildImageBundle: (job: unknown) => Promise<unknown>;
    applyImageBundle: (
      bundle: unknown,
      ctx: unknown,
    ) => Promise<{ kind: string; text?: string; prefix?: string | null }>;
  };
  const verify = async () => {
    const bundle = await target.buildImageBundle({
      message: {},
      botConfigId: 'bot-1',
      systemPrompt: 'x',
      conversationId: 'conv-1',
      tenantId: 'tenant-1',
      phoneNumber: '573001112233',
    });
    return target.applyImageBundle(bundle, {
      conversationId: 'conv-1',
      phoneNumber: '573001112233',
      aiData: { context: {} },
    });
  };
  return { verify, botEscalation };
}

const executed = (
  verdict: Verdict,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  executed: true,
  mode: 'ACTIVE',
  specialistId: 'esp-1',
  recordId: 'rec-1',
  onFailure: 'DEGRADE',
  blockMessage: null,
  exposedVariables: {},
  validUntil: new Date(Date.now() + 3_600_000).toISOString(),
  result: {
    version: 1,
    verdict,
    confidence: 0.4,
    fields: { amount: 123456 },
    reasonCodes: ['LOW_CONFIDENCE'],
    humanSummary: 'resumen',
  },
  ...over,
});

describe('BotRouter: aviso de pendientes de revisión en ACTIVE', () => {
  it.each(['NEEDS_REVIEW', 'ERROR'] as Verdict[])(
    'avisa cuando el resultado es %s',
    async (verdict) => {
      const { verify, botEscalation } = harness(executed(verdict));
      await verify();
      expect(botEscalation.notifyVerificationReview).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        botConfigId: 'bot-1',
        conversationId: 'conv-1',
        contactAddress: '573001112233',
        verdict,
        reasonCodes: ['LOW_CONFIDENCE'],
        recordId: 'rec-1',
      });
    },
  );

  it.each(['VALID', 'INVALID'] as Verdict[])(
    'no avisa con %s',
    async (verdict) => {
      const { verify, botEscalation } = harness(executed(verdict));
      await verify();
      expect(botEscalation.notifyVerificationReview).not.toHaveBeenCalled();
    },
  );

  it('no avisa con un resultado de SHADOW', async () => {
    const { verify, botEscalation } = harness(
      executed('NEEDS_REVIEW', { mode: 'SHADOW' }),
    );
    await verify();
    expect(botEscalation.notifyVerificationReview).not.toHaveBeenCalled();
  });

  it('no avisa si el especialista no se ejecutó', async () => {
    const { verify, botEscalation } = harness({
      executed: false,
      reason: 'BINDING_OFF',
    });
    await verify();
    expect(botEscalation.notifyVerificationReview).not.toHaveBeenCalled();
  });

  it('el aviso no incluye datos extraídos de la imagen', async () => {
    const { verify, botEscalation } = harness(executed('NEEDS_REVIEW'));
    await verify();
    const sent = JSON.stringify(
      (
        botEscalation.notifyVerificationReview.mock.calls[0] as unknown as [
          unknown,
        ]
      )[0],
    );
    expect(sent).not.toContain('123456');
  });

  it('si el aviso falla, la conversación sigue su curso', async () => {
    const { verify } = harness(executed('NEEDS_REVIEW'), { alertFails: true });
    await expect(verify()).resolves.toMatchObject({ kind: 'CONTINUE' });
  });

  it('si el aviso lanza de forma síncrona, la conversación sigue su curso', async () => {
    const { verify, botEscalation } = harness(executed('NEEDS_REVIEW'));
    botEscalation.notifyVerificationReview.mockImplementation(() => {
      throw new Error('servicio sin inicializar');
    });
    await expect(verify()).resolves.toMatchObject({ kind: 'CONTINUE' });
  });

  it('con onFailure BLOCK y ERROR avisa y bloquea', async () => {
    const { verify, botEscalation } = harness(
      executed('ERROR', { onFailure: 'BLOCK' }),
    );
    const result = await verify();
    expect(result.kind).toBe('REPLY');
    expect(typeof result.text).toBe('string');
    expect(botEscalation.notifyVerificationReview).toHaveBeenCalledTimes(1);
  });
});

describe('BotRouter: recoger el resultado adelantado', () => {
  const build = (taken: unknown) => {
    const router = Object.create(BotRouter.prototype) as Record<
      string,
      unknown
    >;
    router.logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    router.imagePrefetch = {
      downloadTimeoutMs: () => 10_000,
      take: jest.fn(() => Promise.resolve(taken)),
    };
    const inline = jest.fn(() => Promise.resolve({ kind: 'UNANALYZED' }));
    router.buildImageBundle = inline;
    const resolve = (id: string | undefined = 'm1') =>
      (
        router as unknown as {
          resolveImageBundle: (m: unknown, j: unknown) => Promise<unknown>;
        }
      ).resolveImageBundle(
        { key: { id } },
        { conversationId: 'c1', botConfigId: 'b1', tenantId: 't1' },
      );
    return { resolve, inline, router };
  };

  it('un resultado listo se usa sin repetir el análisis', async () => {
    const bundle = { kind: 'ACTIVE', outcomes: [] };
    const { resolve, inline } = build({
      status: 'READY',
      value: bundle,
      waitedMs: 0,
    });
    expect(await resolve()).toBe(bundle);
    expect(inline).not.toHaveBeenCalled();
  });

  it('un resultado omitido por el equipo activo se analiza al responder', async () => {
    const { resolve, inline } = build({
      status: 'READY',
      value: { kind: 'SKIPPED' },
      waitedMs: 0,
    });
    await resolve();
    expect(inline).toHaveBeenCalledTimes(1);
  });

  it.each(['MISSING', 'FAILED'])(
    '%s: el respaldo analiza al responder',
    async (status) => {
      const { resolve, inline } = build({ status, waitedMs: 0 });
      await resolve();
      expect(inline).toHaveBeenCalledTimes(1);
    },
  );

  it('si no termina a tiempo se sigue sin analizar y no se repite el análisis', async () => {
    const { resolve, inline } = build({ status: 'TIMEOUT', waitedMs: 43_000 });
    expect(await resolve()).toEqual({ kind: 'UNANALYZED' });
    expect(inline).not.toHaveBeenCalled();
  });

  it('pide el resultado del mensaje y la conversación correctos', async () => {
    const { resolve, router } = build({
      status: 'READY',
      value: { kind: 'UNANALYZED' },
      waitedMs: 0,
    });
    await resolve('WA-9');
    expect(
      (router.imagePrefetch as { take: jest.Mock }).take,
    ).toHaveBeenCalledWith('c1', 'WA-9', expect.any(Number));
  });

  it('un mensaje sin id va directo al respaldo', async () => {
    const { resolve, inline } = build({ status: 'MISSING', waitedMs: 0 });
    await resolve(undefined);
    expect(inline).toHaveBeenCalledTimes(1);
  });
});
