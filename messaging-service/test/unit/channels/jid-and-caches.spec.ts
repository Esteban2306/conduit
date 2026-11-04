import {
  conversationAddress,
  isIgnorableJid,
  isLidAddress,
  jidUser,
} from 'src/channels/whatsapp/utils/jid.util';
import { TtlCacheStore } from 'src/channels/whatsapp/baileys/TtlCacheStore';
import { SentMessageStore } from 'src/channels/whatsapp/baileys/SentMessageStore';

describe('jid.util', () => {
  it.each([
    ['120363@g.us', true],
    ['status@broadcast', true],
    ['123@newsletter', true],
    ['573001234567@s.whatsapp.net', false],
    ['123456789012345@lid', false],
  ])('isIgnorableJid(%s) = %s', (jid, expected) => {
    expect(isIgnorableJid(jid)).toBe(expected);
  });

  it('identifica la conversación por teléfono o, sin él, por LID', () => {
    expect(conversationAddress('573001234567:12@s.whatsapp.net')).toBe(
      '573001234567',
    );
    expect(conversationAddress('123456789012345@lid')).toBe(
      '123456789012345@lid',
    );
  });

  it('un LID no se confunde con un teléfono', () => {
    expect(isLidAddress('123456789012345@lid')).toBe(true);
    expect(isLidAddress('573001234567')).toBe(false);
    expect(jidUser('573001234567:3@s.whatsapp.net')).toBe('573001234567');
  });
});

describe('TtlCacheStore', () => {
  afterEach(() => jest.useRealTimers());

  it('expira las entradas', () => {
    jest.useFakeTimers();
    const cache = new TtlCacheStore(1000);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    jest.advanceTimersByTime(1001);
    expect(cache.get('a')).toBeUndefined();
  });
});

describe('SentMessageStore', () => {
  it('devuelve de memoria lo enviado y, si no está, busca en la tabla Message', async () => {
    const prisma = {
      message: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ renderedBody: 'Recordatorio' }),
      },
    };
    const store = new SentMessageStore(prisma as any);

    store.remember('ABC', { conversation: 'Hola' });
    await expect(store.find('ABC')).resolves.toEqual({ conversation: 'Hola' });
    expect(prisma.message.findFirst).not.toHaveBeenCalled();

    await expect(store.find('XYZ')).resolves.toEqual({
      conversation: 'Recordatorio',
    });
  });
});
