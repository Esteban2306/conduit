jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  downloadMediaMessage: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
  fetchLatestBaileysVersion: jest.fn(),
  makeCacheableSignalKeyStore: jest.fn(),
  BufferJSON: {},
  initAuthCreds: jest.fn(),
  proto: {},
}));

import { NumberConflictHandler } from 'src/channels/whatsapp/NumberConflictHandler';

const conflict = (status: string) => ({
  tenantId: 't1',
  newConnectionId: 'new',
  existing: { id: 'old', key: 'linea', status },
  phoneNumber: '573001112233',
});

function build(enabled: boolean) {
  const adopt = jest.fn().mockResolvedValue(undefined);
  const handler = new NumberConflictHandler(
    { get: jest.fn().mockReturnValue(enabled) } as never,
    { adopt } as never,
  );
  return { handler, adopt };
}

describe('adopción automática por conflicto de número', () => {
  it('con la bandera apagada no hace nada', () => {
    const { handler, adopt } = build(false);
    handler.handle(conflict('ERROR'));
    expect(adopt).not.toHaveBeenCalled();
  });

  it('con la bandera encendida adopta cuando la conexión existente está inactiva', () => {
    const { handler, adopt } = build(true);
    handler.handle(conflict('ERROR'));
    expect(adopt).toHaveBeenCalledWith('t1', 'old', 'new', 'auto-adopt');
  });

  it.each(['CONNECTED', 'CONNECTING', 'BANNED'])(
    'no adopta si la conexión existente está %s',
    (status) => {
      const { handler, adopt } = build(true);
      handler.handle(conflict(status));
      expect(adopt).not.toHaveBeenCalled();
    },
  );

  it('un fallo de la adopción no se propaga', async () => {
    const { handler, adopt } = build(true);
    adopt.mockRejectedValue(new Error('boom'));
    expect(() => handler.handle(conflict('DISCONNECTED'))).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });
});
