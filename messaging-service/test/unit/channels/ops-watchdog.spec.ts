import {
  DAILY_LIMIT_WARN,
  evaluateHealth,
  HealthSnapshot,
  OUTBOX_BACKLOG,
  OUTBOX_STUCK_MS,
  QUEUE_BACKLOG,
} from 'src/channels/whatsapp/alerts/health-rules';
import { OpsWatchdogService } from 'src/channels/whatsapp/alerts/OpsWatchdog.service';

const healthy = (extra: Partial<HealthSnapshot> = {}): HealthSnapshot => ({
  outboxPending: 0,
  outboxOldestPendingMs: 0,
  queueWaiting: 0,
  newDeadLetters: 0,
  models: [
    {
      label: 'ANTHROPIC/haiku',
      tokensUsedToday: 1000,
      dailyTokenLimit: 400_000,
      circuitOpenUntil: null,
      credentialInvalid: false,
    },
  ],
  now: new Date('2026-10-27T15:00:00Z'),
  ...extra,
});

describe('evaluateHealth', () => {
  it('con todo sano no hay hallazgos', () => {
    expect(evaluateHealth(healthy())).toEqual([]);
  });

  it('avisa de respuestas atascadas por antigüedad o por cantidad', () => {
    expect(
      evaluateHealth(
        healthy({ outboxPending: 1, outboxOldestPendingMs: OUTBOX_STUCK_MS }),
      ).map((f) => f.key),
    ).toEqual(['outbox']);
    expect(
      evaluateHealth(healthy({ outboxPending: OUTBOX_BACKLOG })).map(
        (f) => f.key,
      ),
    ).toEqual(['outbox']);
    expect(
      evaluateHealth(
        healthy({
          outboxPending: 3,
          outboxOldestPendingMs: OUTBOX_STUCK_MS - 1,
        }),
      ),
    ).toEqual([]);
  });

  it('avisa de cola creciente y de mensajes fallidos nuevos', () => {
    const keys = evaluateHealth(
      healthy({ queueWaiting: QUEUE_BACKLOG, newDeadLetters: 2 }),
    ).map((f) => f.key);
    expect(keys).toEqual(['queue', 'dlq']);
  });

  it('avisa del límite diario a partir del 80 % y no antes', () => {
    const at = (used: number) =>
      evaluateHealth(
        healthy({
          models: [
            {
              label: 'M',
              tokensUsedToday: used,
              dailyTokenLimit: 100,
              circuitOpenUntil: null,
              credentialInvalid: false,
            },
          ],
        }),
      );
    expect(at(DAILY_LIMIT_WARN * 100 - 1)).toEqual([]);
    expect(at(DAILY_LIMIT_WARN * 100)[0].key).toBe('daily:M');
  });

  it('avisa del circuito abierto y de la credencial rechazada, pero no de un circuito ya vencido', () => {
    const now = new Date('2026-10-27T15:00:00Z');
    const model = (extra: object) => ({
      label: 'M',
      tokensUsedToday: 0,
      dailyTokenLimit: null,
      circuitOpenUntil: null,
      credentialInvalid: false,
      ...extra,
    });
    expect(
      evaluateHealth(
        healthy({
          models: [
            model({ circuitOpenUntil: new Date(now.getTime() + 60_000) }),
          ],
        }),
      ).map((f) => f.key),
    ).toEqual(['circuit:M']);
    expect(
      evaluateHealth(
        healthy({
          models: [model({ circuitOpenUntil: new Date(now.getTime() - 1) })],
        }),
      ),
    ).toEqual([]);
    expect(
      evaluateHealth(
        healthy({ models: [model({ credentialInvalid: true })] }),
      ).map((f) => f.key),
    ).toEqual(['credential:M']);
  });
});

describe('OpsWatchdogService', () => {
  function service(overrides: { tenants?: string[]; pending?: number } = {}) {
    const prisma = {
      whatsAppConnection: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            (overrides.tenants ?? ['t1']).map((tenantId) => ({ tenantId })),
          ),
      },
      outboundReply: {
        count: jest.fn().mockResolvedValue(overrides.pending ?? 0),
        findFirst: jest
          .fn()
          .mockResolvedValue(
            (overrides.pending ?? 0) > 0
              ? { createdAt: new Date(Date.now() - 10 * 60_000) }
              : null,
          ),
      },
      deadLetterMessage: { count: jest.fn().mockResolvedValue(0) },
      aiModelConfig: {
        findMany: jest.fn().mockResolvedValue([
          {
            provider: 'ANTHROPIC',
            model: 'haiku',
            tokensUsedToday: 0,
            dailyTokenLimit: null,
            unavailableUntil: null,
            credentialInvalidAt: null,
          },
        ]),
      },
    };
    const alerts = { report: jest.fn() };
    const queue = { getJobCounts: jest.fn().mockResolvedValue({ waiting: 0 }) };
    const watchdog = new OpsWatchdogService(
      prisma as never,
      alerts as never,
      queue as never,
    );
    return { watchdog, prisma, alerts, queue };
  }

  it('sano: no avisa a nadie', async () => {
    const w = service();
    expect(await w.watchdog.check()).toBe(0);
    expect(w.alerts.report).not.toHaveBeenCalled();
  });

  it('con respuestas atascadas avisa a cada tenant con su propia clave de repetición de 30 min', async () => {
    const w = service({ tenants: ['t1', 't2'], pending: 4 });
    expect(await w.watchdog.check()).toBe(1);
    expect(w.alerts.report).toHaveBeenCalledTimes(2);
    expect(w.alerts.report).toHaveBeenCalledWith(
      't1',
      'capacity',
      expect.stringContaining('respuesta(s) esperando salir'),
      { immediate: true, dedupeKey: 'outbox', dedupeMs: 30 * 60_000 },
    );
  });

  it('si la revisión falla no rompe nada', async () => {
    const w = service();
    w.prisma.outboundReply.count.mockRejectedValue(new Error('db caída'));
    await expect(w.watchdog.check()).resolves.toBe(0);
  });
});
