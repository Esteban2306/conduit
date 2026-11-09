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
  };
  router.specialistRuntime = {
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
    verifyWithSpecialist: (...args: unknown[]) => Promise<unknown>;
  };
  const verify = (): Promise<unknown> =>
    target.verifyWithSpecialist(
      {},
      'bot-1',
      'conv-1',
      'tenant-1',
      '573001112233',
      { context: {} },
    );
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
    await expect(verify()).resolves.toMatchObject({ kind: 'VERIFIED' });
  });

  it('si el aviso lanza de forma síncrona, la conversación sigue su curso', async () => {
    const { verify, botEscalation } = harness(executed('NEEDS_REVIEW'));
    botEscalation.notifyVerificationReview.mockImplementation(() => {
      throw new Error('servicio sin inicializar');
    });
    await expect(verify()).resolves.toMatchObject({ kind: 'VERIFIED' });
  });

  it('con onFailure BLOCK y ERROR avisa y bloquea', async () => {
    const { verify, botEscalation } = harness(
      executed('ERROR', { onFailure: 'BLOCK' }),
    );
    const result = (await verify()) as { kind: string; message: string };
    expect(result.kind).toBe('BLOCK');
    expect(typeof result.message).toBe('string');
    expect(botEscalation.notifyVerificationReview).toHaveBeenCalledTimes(1);
  });
});
