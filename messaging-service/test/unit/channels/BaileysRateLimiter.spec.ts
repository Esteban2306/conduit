import {
  BaileysRateLimiter,
  JobPriority,
  WarmupLevel,
} from 'src/channels/whatsapp/baileys/BaileysRateLimiter';

// 2026-10-10 23:00 en Bogotá (04:00 UTC del día siguiente): fuera de horario.
const NIGHT = new Date('2026-10-11T04:00:00Z');
// 2026-10-10 10:00 en Bogotá: dentro de horario.
const MORNING = new Date('2026-10-10T15:00:00Z');

const ok = () => Promise.resolve({ success: true });

describe('BaileysRateLimiter — carriles de conversación y campaña', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  function limiter() {
    return new BaileysRateLimiter('conn-test-1', WarmupLevel.NORMAL);
  }

  it('responde a una conversación fuera del horario activo', async () => {
    jest.useFakeTimers({ now: NIGHT });
    const sent: string[] = [];

    const done = limiter().enqueue(
      () => {
        sent.push('respuesta');
        return ok();
      },
      { priority: JobPriority.CONVERSATION },
    );
    await jest.advanceTimersByTimeAsync(0);

    expect(sent).toEqual(['respuesta']);
    await expect(done).resolves.toEqual({ success: true });
  });

  it('una campaña de noche espera hasta las 8:00 de Bogotá', async () => {
    jest.useFakeTimers({ now: NIGHT });
    const sent: string[] = [];

    void limiter().enqueue(() => {
      sent.push('recordatorio');
      return ok();
    });

    await jest.advanceTimersByTimeAsync(9 * 3600_000 - 60_000); // 07:59
    expect(sent).toEqual([]);

    await jest.advanceTimersByTimeAsync(120_000); // 08:01
    expect(sent).toEqual(['recordatorio']);
  });

  it('una conversación interrumpe la espera de una campaña y sale primero', async () => {
    jest.useFakeTimers({ now: NIGHT });
    const rl = limiter();
    const sent: string[] = [];

    void rl.enqueue(() => {
      sent.push('recordatorio');
      return ok();
    });
    await jest.advanceTimersByTimeAsync(10 * 60_000);

    void rl.enqueue(
      () => {
        sent.push('respuesta');
        return ok();
      },
      { priority: JobPriority.CONVERSATION },
    );
    await jest.advanceTimersByTimeAsync(0);

    expect(sent).toEqual(['respuesta']);
    expect(rl.getLaneSizes()).toEqual({ conversation: 0, campaign: 1 });
  });

  it('nunca envía dos mensajes a la vez y separa las respuestas', async () => {
    jest.useFakeTimers({ now: MORNING });
    const rl = limiter();
    const sentAt: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const send = () => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      sentAt.push(Date.now());
      await new Promise((r) => setTimeout(r, 500));
      inFlight--;
      return { success: true };
    };

    for (let i = 0; i < 3; i++) {
      void rl.enqueue(send(), { priority: JobPriority.CONVERSATION });
    }
    await jest.advanceTimersByTimeAsync(60_000);

    expect(sentAt).toHaveLength(3);
    expect(maxInFlight).toBe(1);
    for (let i = 1; i < sentAt.length; i++) {
      expect(sentAt[i] - sentAt[i - 1]).toBeGreaterThanOrEqual(1500);
    }
  });

  it('las respuestas no consumen el tope por hora de campaña', async () => {
    jest.useFakeTimers({ now: MORNING });
    const rl = limiter();
    const sent: string[] = [];

    for (let i = 0; i < 25; i++) {
      void rl.enqueue(
        () => {
          sent.push(`r${i}`);
          return ok();
        },
        { priority: JobPriority.CONVERSATION },
      );
    }
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(sent).toHaveLength(25); // > 18/h de campaña en nivel NORMAL

    void rl.enqueue(() => {
      sent.push('campaña');
      return ok();
    });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(sent.at(-1)).toBe('campaña');
  });
});
