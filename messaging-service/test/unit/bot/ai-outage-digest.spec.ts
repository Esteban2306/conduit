import {
  AiOutageDigestService,
  OUTAGE_DIGEST_MAX_ATTEMPTS,
  OUTAGE_DIGEST_MAX_LISTED,
  OUTAGE_DIGEST_RETRY_MS,
  OUTAGE_DIGEST_WINDOW_MS,
} from 'src/bot/tools/AiOutageDigest.service';

function build(results: Array<boolean | Error> = [true]) {
  const sent: string[] = [];
  let call = 0;
  const escalation = {
    notifyContacts: jest.fn(
      async (_t: string, _b: string, _s: string, message: string) => {
        sent.push(message);
        const next = results[Math.min(call, results.length - 1)];
        call += 1;
        if (next instanceof Error) throw next;
        return next;
      },
    ),
  };
  const service = new AiOutageDigestService(escalation as never);
  (service as unknown as { logger: object }).logger = {
    error: jest.fn(),
    warn: jest.fn(),
    log: jest.fn(),
  };
  return { service, sent, escalation };
}

describe('AiOutageDigestService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('un solo chat afectado: aviso individual tras la ventana', async () => {
    const { service, sent } = build();
    service.report('t', 'bot', '573001', 'sin saldo');
    expect(sent).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(OUTAGE_DIGEST_WINDOW_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/Cliente afectado: 573001/);
  });

  it('varios chats en la ventana salen en UN solo mensaje con la lista', async () => {
    const { service, sent } = build();
    service.report('t', 'bot', '573001', 'sin saldo');
    service.report('t', 'bot', '573002', 'sin saldo');
    service.report('t', 'bot', '573001', 'sin saldo');
    await jest.advanceTimersByTimeAsync(OUTAGE_DIGEST_WINDOW_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/2 chats afectados/);
    expect(sent[0]).toMatch(/573001 \(2 mensajes\)/);
    expect(sent[0]).toMatch(/573002/);
  });

  it('la lista se acota y resume el resto', async () => {
    const { service, sent } = build();
    for (let i = 0; i < OUTAGE_DIGEST_MAX_LISTED + 5; i++) {
      service.report('t', 'bot', `5730${i}`, 'x');
    }
    await jest.advanceTimersByTimeAsync(OUTAGE_DIGEST_WINDOW_MS);
    expect(sent[0]).toMatch(/y 5 chat\(s\) más/);
  });

  it('bots distintos no se mezclan', async () => {
    const { service, sent, escalation } = build();
    service.report('t', 'botA', '1', 'x');
    service.report('t', 'botB', '2', 'x');
    await jest.advanceTimersByTimeAsync(OUTAGE_DIGEST_WINDOW_MS);
    expect(sent).toHaveLength(2);
    expect(
      escalation.notifyContacts.mock.calls.map((c) => c[1]).sort(),
    ).toEqual(['botA', 'botB']);
  });

  it('un fallo posterior a un envío abre un lote nuevo', async () => {
    const { service, sent } = build();
    service.report('t', 'bot', '1', 'x');
    await jest.advanceTimersByTimeAsync(OUTAGE_DIGEST_WINDOW_MS);
    service.report('t', 'bot', '2', 'x');
    await jest.advanceTimersByTimeAsync(OUTAGE_DIGEST_WINDOW_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toMatch(/Cliente afectado: 1\b/);
  });

  it('si nadie fue notificado conserva el lote y reintenta; luego no repite', async () => {
    const { service, sent } = build([false, true]);
    service.report('t', 'bot', '1', 'x');
    service.report('t', 'bot', '2', 'x');
    await jest.advanceTimersByTimeAsync(OUTAGE_DIGEST_WINDOW_MS);
    expect(sent).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(OUTAGE_DIGEST_RETRY_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatch(/2 chats afectados/);
    await jest.advanceTimersByTimeAsync(OUTAGE_DIGEST_RETRY_MS * 3);
    expect(sent).toHaveLength(2);
  });

  it('un error al enviar también reintenta y termina descartando con error en el log', async () => {
    const { service, sent } = build([new Error('sin red')]);
    service.report('t', 'bot', '1', 'x');
    await jest.advanceTimersByTimeAsync(OUTAGE_DIGEST_WINDOW_MS);
    await jest.advanceTimersByTimeAsync(
      OUTAGE_DIGEST_RETRY_MS * OUTAGE_DIGEST_MAX_ATTEMPTS,
    );
    expect(sent).toHaveLength(OUTAGE_DIGEST_MAX_ATTEMPTS);
    const logger = (service as unknown as { logger: { error: jest.Mock } })
      .logger;
    expect(
      logger.error.mock.calls.some((c) => /NO fueron notificados/.test(c[0])),
    ).toBe(true);
  });

  it('al apagar el módulo envía lo pendiente', async () => {
    const { service, sent } = build();
    service.report('t', 'bot', '1', 'x');
    await service.onModuleDestroy();
    expect(sent).toHaveLength(1);
  });
});
