jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
  fetchLatestBaileysVersion: jest.fn(),
  makeCacheableSignalKeyStore: jest.fn(),
  BufferJSON: {},
  initAuthCreds: jest.fn(),
  proto: {},
}));

import { chatKey, chatKeyPrefix } from 'src/channels/whatsapp/utils/chat-key';
import { messageReceiptTracker } from 'src/channels/whatsapp/baileys/MessageReceiptTracker';
import { BaileysSessionManager } from 'src/channels/whatsapp/baileys/BaileysSessionManager';

const CONN = '1e93c204-5e78-4dca-bd5c-cbda632c91c9';

describe('chatKey', () => {
  it('conserva el teléfono completo y quita solo el sufijo de dispositivo', () => {
    expect(chatKey(CONN, '573000000001@s.whatsapp.net')).toBe(
      `${CONN}|573000000001`,
    );
    expect(chatKey(CONN, '573000000001:12@s.whatsapp.net')).toBe(
      `${CONN}|573000000001`,
    );
  });

  it('distingue chats y conexiones', () => {
    expect(chatKey(CONN, '573000000001@s.whatsapp.net')).not.toBe(
      chatKey(CONN, '573000000002@s.whatsapp.net'),
    );
    expect(chatKey('otra', '573000000001@s.whatsapp.net')).not.toBe(
      chatKey(CONN, '573000000001@s.whatsapp.net'),
    );
    expect(
      chatKey(CONN, '573000000001@s.whatsapp.net').startsWith(
        chatKeyPrefix(CONN),
      ),
    ).toBe(true);
  });

  it('un LID sin teléfono conocido conserva su dirección LID', () => {
    expect(chatKey(CONN, '123456789012345:3@lid')).toBe(
      `${CONN}|123456789012345@lid`,
    );
  });
});

describe('messageReceiptTracker con claves opacas', () => {
  it('la actividad de un chat no afecta a otro', () => {
    const tracker = new messageReceiptTracker();
    const a = chatKey(CONN, '573000000001@s.whatsapp.net');
    const b = chatKey(CONN, '573000000002@s.whatsapp.net');
    tracker.markChatActive(a);
    tracker.markTyping(a);
    expect(tracker.isChatActive(a)).toBe(true);
    expect(tracker.isTyping(a)).toBe(true);
    expect(tracker.isChatActive(b)).toBe(false);
    expect(tracker.isTyping(b)).toBe(false);
    expect(tracker.msSinceActive(b)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('BaileysSessionManager.chatKeyFor', () => {
  it('resuelve un LID ya visto al teléfono de la clienta: presencia y mensajes usan la misma clave', () => {
    const manager = Object.create(
      BaileysSessionManager.prototype,
    ) as BaileysSessionManager;
    const chatAddresses = new Map<string, string>([
      [`${CONN}|123456789012345`, '573000000001'],
    ]);
    Object.assign(manager, { chatAddresses });
    const keyFor = (jid: string) =>
      (
        manager as unknown as { chatKeyFor: (c: string, j: string) => string }
      ).chatKeyFor(CONN, jid);
    expect(keyFor('123456789012345@lid')).toBe(
      chatKey(CONN, '573000000001@s.whatsapp.net'),
    );
    expect(keyFor('999@lid')).toBe(`${CONN}|999@lid`);
  });
});
