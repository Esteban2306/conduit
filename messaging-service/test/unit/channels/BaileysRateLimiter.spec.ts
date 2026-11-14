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

describe('BaileysRateLimiter — respuestas detenidas a propósito', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('descartar una respuesta desactualizada o esperar a que el cliente termine de escribir no sube el riesgo del número', async () => {
    jest.useFakeTimers({ now: MORNING });
    const limiter = new BaileysRateLimiter('conn-gate-1', WarmupLevel.NORMAL);

    for (let i = 0; i < 12; i++) {
      const code = i % 2 === 0 ? 'SUPERSEDED' : 'CLIENT_TYPING';
      const done = limiter.enqueue(
        () => Promise.resolve({ success: false, errorCode: code }),
        { priority: JobPriority.CONVERSATION, maxAttempts: 1 },
      );
      await jest.advanceTimersByTimeAsync(0);
      await expect(done).resolves.toMatchObject({ errorCode: code });
    }

    expect(limiter.getRiskLevel()).toBe(1);
  });

  it('un fallo real de envío sí cuenta para el riesgo', async () => {
    jest.useFakeTimers({ now: MORNING });
    const limiter = new BaileysRateLimiter('conn-gate-2', WarmupLevel.NORMAL);

    for (let i = 0; i < 12; i++) {
      const done = limiter.enqueue(
        () => Promise.resolve({ success: false, errorCode: 'SEND_FAILED' }),
        { priority: JobPriority.CONVERSATION, maxAttempts: 1 },
      );
      await jest.advanceTimersByTimeAsync(0);
      await done;
    }

    expect(limiter.getRiskLevel()).toBeGreaterThan(1);
  });
});

describe('BaileysRateLimiter — pausa entre chats según lo que se acaba de enviar', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: MORNING });
    // Sin azar: la variación de la pausa queda en 1,0 y las pruebas son exactas.
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function setup() {
    const limiter = new BaileysRateLimiter('conn-cross-1', WarmupLevel.NORMAL);
    const sent: string[] = [];
    const reply = (chat: string, characters: number) =>
      limiter.enqueue(
        () => {
          sent.push(chat);
          return ok();
        },
        {
          priority: JobPriority.CONVERSATION,
          chatKey: chat,
          weight: characters,
        },
      );
    return { limiter, sent, reply };
  }

  it('tras una respuesta larga, otro chat espera lo que una persona tardaría (hasta 30 s)', async () => {
    const { sent, reply } = setup();
    void reply('A', 400);
    await jest.advanceTimersByTimeAsync(0);
    void reply('B', 50);

    await jest.advanceTimersByTimeAsync(29_000);
    expect(sent).toEqual(['A']);

    await jest.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual(['A', 'B']);
  });

  it('tras una respuesta corta la pausa es de unos 6 s, no de 30', async () => {
    const { sent, reply } = setup();
    void reply('A', 20);
    await jest.advanceTimersByTimeAsync(0);
    void reply('B', 20);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(sent).toEqual(['A']);

    await jest.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual(['A', 'B']);
  });

  it('crece con el largo: 150 caracteres piden unos 18 s', async () => {
    const { sent, reply } = setup();
    void reply('A', 150);
    await jest.advanceTimersByTimeAsync(0);
    void reply('B', 20);

    await jest.advanceTimersByTimeAsync(17_000);
    expect(sent).toEqual(['A']);

    await jest.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual(['A', 'B']);
  });

  it('las burbujas de una misma respuesta al mismo chat salen con la separación de siempre', async () => {
    const { sent, reply } = setup();
    void reply('A', 400);
    await jest.advanceTimersByTimeAsync(0);
    void reply('A', 400);

    await jest.advanceTimersByTimeAsync(5_000);
    expect(sent).toEqual(['A', 'A']);
  });

  it('si ya pasó el tiempo, el siguiente chat no espera nada más', async () => {
    const { sent, reply } = setup();
    void reply('A', 400);
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(40_000);

    void reply('B', 50);
    await jest.advanceTimersByTimeAsync(0);

    expect(sent).toEqual(['A', 'B']);
  });

  it('una respuesta que se detuvo sin enviarse no obliga a esperar al siguiente chat', async () => {
    const { limiter, sent, reply } = setup();
    const stopped = limiter.enqueue(
      () => Promise.resolve({ success: false, errorCode: 'SUPERSEDED' }),
      {
        priority: JobPriority.CONVERSATION,
        chatKey: 'A',
        weight: 400,
        maxAttempts: 1,
      },
    );
    await jest.advanceTimersByTimeAsync(0);
    await stopped;
    void reply('B', 50);
    await jest.advanceTimersByTimeAsync(0);

    expect(sent).toEqual(['B']);
  });

  it('sin chatKey (envíos que no la traen) se comporta como antes', async () => {
    const { limiter, sent } = setup();
    for (const name of ['x', 'y']) {
      void limiter.enqueue(
        () => {
          sent.push(name);
          return ok();
        },
        { priority: JobPriority.CONVERSATION },
      );
    }
    await jest.advanceTimersByTimeAsync(5_000);

    expect(sent).toEqual(['x', 'y']);
  });
});
