import {
  BaileysRateLimiter,
  JobPriority,
  WarmupLevel,
} from 'src/channels/whatsapp/baileys/BaileysRateLimiter';

const MORNING = new Date('2026-10-10T15:00:00Z');
const ok = () => Promise.resolve({ success: true });
const minutesAgo = (m: number) => MORNING.getTime() - m * 60_000;

describe('BaileysRateLimiter: estado que sobrevive al reinicio', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  const limiter = (level = WarmupLevel.NORMAL) =>
    new BaileysRateLimiter('conn-persist-1', level);

  it('tras un reinicio sigue contando lo enviado: sobre el ritmo habitual espacia, en el techo absoluto espera', async () => {
    jest.useFakeTimers({ now: MORNING });
    const soft = limiter(WarmupLevel.FRESH);
    soft.hydrate({
      conversationSentAt: [
        ...Array.from({ length: 59 }, (_, i) => minutesAgo(59 - i * 0.9)),
        MORNING.getTime() - 5_000,
      ],
      campaignSentAt: [],
      riskLevel: 1,
      riskUpdatedAt: null,
    });
    const started = Date.now();
    let softAt = 0;
    void soft.enqueue(
      () => {
        softAt = Date.now();
        return ok();
      },
      { priority: JobPriority.CONVERSATION },
    );
    await jest.advanceTimersByTimeAsync(3 * 60_000);
    expect(softAt - started).toBeGreaterThanOrEqual(30_000);
    expect(softAt - started).toBeLessThanOrEqual(60_000);

    const hard = limiter(WarmupLevel.FRESH);
    hard.hydrate({
      conversationSentAt: Array.from(
        { length: 90 },
        (_, i) => Date.now() - (59 - i * 0.6) * 60_000,
      ),
      campaignSentAt: [],
      riskLevel: 1,
      riskUpdatedAt: null,
    });
    const sent: number[] = [];
    void hard.enqueue(
      () => {
        sent.push(Date.now());
        return ok();
      },
      { priority: JobPriority.CONVERSATION },
    );
    await jest.advanceTimersByTimeAsync(20_000);
    expect(sent).toEqual([]);
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(sent).toHaveLength(1);
  });

  it('el último envío anterior al reinicio cuenta para la separación mínima', async () => {
    jest.useFakeTimers({ now: MORNING });
    const rl = limiter();
    rl.hydrate({
      conversationSentAt: [MORNING.getTime() - 500],
      campaignSentAt: [],
      riskLevel: 1,
      riskUpdatedAt: null,
    });
    const started = Date.now();
    let at = 0;
    void rl.enqueue(
      () => {
        at = Date.now();
        return ok();
      },
      { priority: JobPriority.CONVERSATION },
    );
    await jest.advanceTimersByTimeAsync(10_000);
    expect(at - started).toBeGreaterThanOrEqual(2_500);
  });

  it('los mensajes proactivos de la última hora y del día cuentan tras el reinicio', async () => {
    jest.useFakeTimers({ now: MORNING });
    const rl = limiter(WarmupLevel.NORMAL);
    rl.hydrate({
      conversationSentAt: [],
      campaignSentAt: Array.from({ length: 18 }, (_, i) => minutesAgo(50 - i)),
      riskLevel: 1,
      riskUpdatedAt: null,
    });
    const sent: string[] = [];
    void rl.enqueue(() => {
      sent.push('campaña');
      return ok();
    });
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent).toEqual([]);
    await jest.advanceTimersByTimeAsync(60 * 60_000);
    expect(sent).toEqual(['campaña']);
  });

  it('el riesgo guardado baja un nivel por hora transcurrida', () => {
    jest.useFakeTimers({ now: MORNING });
    const rl = limiter();
    rl.hydrate({
      conversationSentAt: [],
      campaignSentAt: [],
      riskLevel: 4,
      riskUpdatedAt: new Date(minutesAgo(130)),
    });
    expect(rl.getRiskLevel()).toBe(2);

    const fresh = limiter();
    fresh.hydrate({
      conversationSentAt: [],
      campaignSentAt: [],
      riskLevel: 3,
      riskUpdatedAt: new Date(minutesAgo(5)),
    });
    expect(fresh.getRiskLevel()).toBe(3);
  });

  it('los cambios de riesgo se notifican para guardarse', async () => {
    jest.useFakeTimers({ now: MORNING });
    const rl = limiter();
    const levels: number[] = [];
    rl.setRiskListener((level) => levels.push(level));
    const bad = () =>
      Promise.resolve({
        success: false,
        retryable: false,
        errorCode: 'SEND_FAILED',
      });
    for (let i = 0; i < 3; i++) {
      void rl.enqueue(bad, {
        priority: JobPriority.CONVERSATION,
        maxAttempts: 1,
      });
    }
    await jest.advanceTimersByTimeAsync(60_000);
    expect(levels).toEqual([2]);
    expect(rl.getRiskLevel()).toBe(2);
  });

  it('un canal desconectado no sube el riesgo ni se reintenta dentro del limitador', async () => {
    jest.useFakeTimers({ now: MORNING });
    const rl = limiter();
    const levels: number[] = [];
    rl.setRiskListener((level) => levels.push(level));
    let calls = 0;
    const notConnected = () => {
      calls++;
      return Promise.resolve({
        success: false,
        retryable: true,
        errorCode: 'WHATSAPP_NOT_CONNECTED',
      });
    };
    for (let i = 0; i < 6; i++) {
      void rl.enqueue(notConnected, {
        priority: JobPriority.CONVERSATION,
        maxAttempts: 1,
      });
    }
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toBe(6);
    expect(levels).toEqual([]);
    expect(rl.getRiskLevel()).toBe(1);
  });
});
