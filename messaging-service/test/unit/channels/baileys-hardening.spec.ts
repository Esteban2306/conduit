import { EventEmitter } from 'events';

// Baileys es solo ESM: se simula lo que usan el plugin y el session manager.
const fakeSockets: FakeSocket[] = [];
jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(() => {
    const sock = new FakeSocket();
    fakeSockets.push(sock);
    return sock;
  }),
  DisconnectReason: {
    loggedOut: 401,
    connectionReplaced: 440,
    forbidden: 403,
    restartRequired: 515,
  },
  fetchLatestBaileysVersion: jest
    .fn()
    .mockResolvedValue({ version: [2, 3000, 1], isLatest: true }),
  makeCacheableSignalKeyStore: jest.fn((keys: unknown) => keys),
  BufferJSON: { replacer: undefined, reviver: undefined },
  initAuthCreds: jest.fn(() => ({})),
  proto: {
    Message: { AppStateSyncKeyData: { fromObject: (v: unknown) => v } },
  },
}));

class FakeSocket {
  ev = new EventEmitter();
  user = { id: '573000000000:1@s.whatsapp.net' };
  signalRepository = {
    lidMapping: { getPNForLID: jest.fn().mockResolvedValue(null) },
  };
  onWhatsApp = jest.fn().mockResolvedValue([{ exists: true }]);
  sendPresenceUpdate = jest.fn().mockResolvedValue(undefined);
  sendMessage = jest
    .fn()
    .mockResolvedValue({
      key: { id: 'WAID1' },
      message: { conversation: 'x' },
    });
  end = jest.fn().mockResolvedValue(undefined);
}

import { BaileysPlugin } from 'src/channels/whatsapp/baileys/BaileysPlugin';
import { BaileysSessionManager } from 'src/channels/whatsapp/baileys/BaileysSessionManager';

const flush = () => new Promise((r) => setImmediate(r));

describe('BaileysPlugin — endurecimiento', () => {
  const runNow = { enqueue: jest.fn((fn: () => Promise<unknown>) => fn()) };
  let sock: FakeSocket;
  let session: { isConnected: jest.Mock; get: jest.Mock };
  let contacts: {
    campaignGate: jest.Mock;
    cachedExistence: jest.Mock;
    saveExistence: jest.Mock;
  };
  let plugin: BaileysPlugin;

  beforeEach(() => {
    jest.useFakeTimers();
    sock = new FakeSocket();
    session = {
      isConnected: jest.fn().mockReturnValue(true),
      get: jest.fn().mockReturnValue(sock),
    };
    contacts = {
      campaignGate: jest.fn().mockResolvedValue({ allowed: true }),
      cachedExistence: jest.fn().mockResolvedValue(null),
      saveExistence: jest.fn().mockResolvedValue(undefined),
    };
    plugin = new BaileysPlugin(
      { get: () => runNow, getOrCreate: () => runNow } as any,
      session as any,
      { register: jest.fn() } as any,
      contacts as any,
      { remember: jest.fn() } as any,
    );
  });

  afterEach(() => jest.useRealTimers());

  async function send(payload: Record<string, unknown>) {
    const promise = plugin.send({
      content: 'Hola',
      connectionId: 'c1',
      ...payload,
    } as any);
    await jest.runAllTimersAsync();
    return promise;
  }

  it('bloquea una campaña a quien no escribió, sin tocar WhatsApp', async () => {
    contacts.campaignGate.mockResolvedValue({
      allowed: false,
      reason: 'nunca escribió',
    });

    const result = await send({ to: '+573001234567' });

    expect(result).toMatchObject({
      success: false,
      errorCode: 'RECIPIENT_NOT_OPTED_IN',
      retryable: false,
    });
    expect(sock.sendMessage).not.toHaveBeenCalled();
  });

  it('una respuesta de conversación no pasa por la regla ni consulta onWhatsApp', async () => {
    const result = await send({
      to: '573001234567',
      priority: 'conversation',
    });

    expect(result.success).toBe(true);
    expect(contacts.campaignGate).not.toHaveBeenCalled();
    expect(sock.onWhatsApp).not.toHaveBeenCalled();
  });

  it('usa la caché de existencia en vez de consultar a WhatsApp', async () => {
    contacts.cachedExistence.mockResolvedValue(true);

    await send({ to: '573001234567' });

    expect(sock.onWhatsApp).not.toHaveBeenCalled();
    expect(sock.sendMessage).toHaveBeenCalled();
  });

  it('consulta una sola vez y guarda el resultado', async () => {
    await send({ to: '573001234567' });

    expect(sock.onWhatsApp).toHaveBeenCalledTimes(1);
    expect(contacts.saveExistence).toHaveBeenCalledWith(
      'c1',
      '573001234567',
      true,
    );
  });

  it('responde a un LID solo en conversación', async () => {
    const reply = await send({
      to: '123456789012345@lid',
      priority: 'conversation',
    });
    expect(reply.success).toBe(true);
    expect(sock.sendMessage).toHaveBeenCalledWith(
      '123456789012345@lid',
      expect.any(Object),
    );

    const campaign = await send({ to: '123456789012345@lid' });
    expect(campaign).toMatchObject({ errorCode: 'INVALID_RECIPIENT' });
  });

  it('obtiene el socket al enviar: si se desconectó mientras esperaba, falla reintentable', async () => {
    session.get.mockReturnValueOnce(sock).mockReturnValue(undefined);
    session.isConnected
      .mockReturnValueOnce(true) // al encolar
      .mockReturnValue(false); // al enviar

    const result = await send({ to: '573001234567' });

    expect(result).toMatchObject({
      errorCode: 'WHATSAPP_NOT_CONNECTED',
      retryable: true,
    });
  });
});

describe('BaileysSessionManager — cierres de conexión y lease', () => {
  let connections: Record<string, jest.Mock>;
  let manager: BaileysSessionManager;

  beforeEach(() => {
    fakeSockets.length = 0;
    connections = {
      findForSessionManager: jest.fn().mockResolvedValue({
        id: 'c1',
        tenantId: 't1',
        botConfigId: null,
        warmupLevel: 'NORMAL',
      }),
      acquireSessionLease: jest.fn().mockResolvedValue(null),
      releaseSessionLease: jest.fn().mockResolvedValue(undefined),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      markConnected: jest.fn().mockResolvedValue(undefined),
      updateQR: jest.fn(),
    };
    const prisma = {
      whatsAppSession: {
        findUnique: jest.fn().mockResolvedValue(null),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    manager = new BaileysSessionManager(
      {} as any,
      prisma as any,
      connections as any,
      {
        getOrCreate: jest.fn(),
        enterReconnectThrottle: jest.fn(),
        reportDisconnect: jest.fn(),
      } as any,
      { markChatActive: jest.fn() } as any,
      { consume: jest.fn() } as any,
      { recordInbound: jest.fn(), findAddressByLid: jest.fn() } as any,
      { find: jest.fn() } as any,
    );
  });

  afterEach(async () => {
    await manager.onApplicationShutdown();
  });

  function close(code: number) {
    fakeSockets[0].ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: code, payload: {} } } },
    });
  }

  it('no abre socket si otra instancia tiene el lease', async () => {
    connections.acquireSessionLease.mockResolvedValue(
      new Date(Date.now() + 60_000),
    );

    await manager.start('c1');

    expect(fakeSockets).toHaveLength(0);
  });

  it('440 (sesión reemplazada): se detiene, marca ERROR y no reconecta', async () => {
    await manager.start('c1');
    close(440);
    await flush();
    await flush();

    expect(connections.updateStatus).toHaveBeenCalledWith('c1', 'ERROR');
    expect(fakeSockets).toHaveLength(1);
  });

  it('403 (prohibido): marca BANNED y no reconecta', async () => {
    await manager.start('c1');
    close(403);
    await flush();
    await flush();

    expect(connections.updateStatus).toHaveBeenCalledWith('c1', 'BANNED');
    expect(fakeSockets).toHaveLength(1);
  });

  it('515 (reinicio requerido): reconecta de inmediato', async () => {
    await manager.start('c1');
    close(515);
    for (let i = 0; i < 5; i++) await flush();

    expect(fakeSockets).toHaveLength(2);
  });
});
