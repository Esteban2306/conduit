jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
  proto: {},
}));

import { BaileysPlugin } from 'src/channels/whatsapp/baileys/BaileysPlugin';

function plugin() {
  const calls: Array<{ kind: string; arg?: unknown }> = [];
  const sock = {
    sendPresenceUpdate: jest.fn((state: string) => {
      calls.push({ kind: state });
      return Promise.resolve();
    }),
    sendMessage: jest.fn((_jid: string, content: { text: string }) => {
      calls.push({ kind: 'send', arg: content.text });
      return Promise.resolve({ key: { id: 'WAID1' }, message: {} });
    }),
  };
  const instance = new BaileysPlugin(
    { get: () => ({ enqueue: (fn: () => unknown) => fn() }) } as never,
    { isConnected: () => true, get: () => sock } as never,
    { register: jest.fn() } as never,
    {
      campaignGate: () => Promise.resolve({ allowed: true }),
      cachedExistence: () => Promise.resolve(true),
    } as never,
    { remember: jest.fn() } as never,
  );
  return { instance, sock, calls };
}

const run = async (promise: Promise<unknown>) => {
  await jest.runAllTimersAsync();
  return promise;
};

describe('BaileysPlugin: secuencia de envío', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('escribiendo → pausa → envío, y la respuesta sale sin caracteres invisibles', async () => {
    const { instance, calls } = plugin();
    const result = await run(
      instance.send({
        to: '573001112233',
        content: 'Claro, te agendo para el martes.',
        subject: '',
        connectionId: 'c1',
        priority: 'conversation',
      }),
    );
    expect(result).toMatchObject({ success: true });
    expect(calls.map((c) => c.kind)).toEqual(['composing', 'paused', 'send']);
    expect(calls[2].arg).toBe('Claro, te agendo para el martes.');
  });

  it('un mensaje proactivo conserva la variación invisible', async () => {
    const { instance, calls } = plugin();
    await run(
      instance.send({
        to: '573001112233',
        content: 'Recordatorio de tu cita',
        subject: '',
        connectionId: 'c1',
        priority: 'campaign',
      }),
    );
    const sent = calls.find((c) => c.kind === 'send')!.arg as string;
    expect(sent.startsWith('Recordatorio de tu cita')).toBe(true);
    expect(sent.length).toBeGreaterThan('Recordatorio de tu cita'.length);
  });

  it('un mensaje largo tarda más en "escribirse" que uno corto', async () => {
    const durations: number[] = [];
    for (const length of [10, 400]) {
      const { instance } = plugin();
      const started = Date.now();
      let finished = 0;
      const sending = instance
        .send({
          to: '573001112233',
          content: 'x'.repeat(length),
          subject: '',
          connectionId: 'c1',
          priority: 'conversation',
        })
        .then(() => {
          finished = Date.now();
        });
      await jest.runAllTimersAsync();
      await sending;
      durations.push(finished - started);
    }
    expect(durations[1]).toBeGreaterThan(durations[0]);
  });
});
