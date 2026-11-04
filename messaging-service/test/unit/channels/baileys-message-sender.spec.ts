jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  downloadMediaMessage: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
  fetchLatestBaileysVersion: jest.fn(),
  makeCacheableSignalKeyStore: jest.fn(),
  generateMessageIDV2: jest.fn(() => 'WAID'),
  BufferJSON: {},
  initAuthCreds: jest.fn(),
  proto: {},
}));
jest.mock('src/channels/whatsapp/baileys/BaileysPlugin', () => ({
  BaileysPlugin: class {},
}));

import { BaileysMessageSender } from 'src/channels/whatsapp/baileys/BaileysMessageSender';
import { ReplyMetricsService } from 'src/bot/router/reply-metrics.service';

function setup(options: { enqueueFails?: boolean } = {}) {
  const sent: string[] = [];
  const plugin = {
    send: jest.fn((payload: { content: string }) => {
      sent.push(payload.content);
      return Promise.resolve({ success: true, providerMessageId: 'id' });
    }),
  };
  const conversations = {
    saveOutbound: jest.fn().mockResolvedValue(undefined),
    saveHumanOutbound: jest.fn().mockResolvedValue(undefined),
  };
  const eventBus = { publish: jest.fn() };
  const metrics = new ReplyMetricsService();
  const outbox = {
    enqueue: jest.fn(() =>
      options.enqueueFails
        ? Promise.reject(new Error('db caída'))
        : Promise.resolve('g1'),
    ),
    tenantOf: jest.fn().mockResolvedValue('tenant-1'),
  };
  const dispatcher = { kick: jest.fn() };
  const sender = new BaileysMessageSender(
    plugin as never,
    conversations as never,
    eventBus as never,
    metrics,
    outbox as never,
    dispatcher as never,
  );
  const send = (content: string, extra: Record<string, unknown> = {}) =>
    sender.handleSendRequested({
      payload: {
        phoneNumber: '573000000001',
        content,
        conversationId: 'c1',
        connectionId: 'conn',
        tenantId: 't1',
        ...extra,
      },
    } as never);
  return {
    sent,
    plugin,
    conversations,
    eventBus,
    metrics,
    outbox,
    dispatcher,
    send,
  };
}

describe('BaileysMessageSender', () => {
  it('propiedad: ningún texto vacío o en blanco llega al canal ni a la bandeja, venga de donde venga', async () => {
    const blanks = ['', ' ', '\n', '\t\n ', '​', '​\n‍', '﻿', ' '];
    const w = setup();
    for (const blank of blanks) {
      for (const sentBy of [undefined, 'human']) {
        const result = await w.send(blank, { sentBy });
        expect(result).toEqual({ success: false, error: 'EMPTY_MESSAGE' });
      }
    }
    expect(w.plugin.send).not.toHaveBeenCalled();
    expect(w.outbox.enqueue).not.toHaveBeenCalled();
    expect(w.metrics.snapshot().blockedEmpty).toBe(blanks.length * 2);
  });

  it('la respuesta del bot se guarda en la bandeja de salida dividida en burbujas y no se envía aquí', async () => {
    const w = setup();
    const result = await w.send('Tengo cupo el lunes.\n\n¿Te sirve a las 9?', {
      tokensUsed: 12,
    });
    expect(result).toEqual({ success: true });
    expect(w.outbox.enqueue).toHaveBeenCalledWith({
      tenantId: 't1',
      connectionId: 'conn',
      conversationId: 'c1',
      phoneNumber: '573000000001',
      bubbles: ['Tengo cupo el lunes.', '¿Te sirve a las 9?'],
      tokensUsed: 12,
      imageVerified: undefined,
    });
    expect(w.dispatcher.kick).toHaveBeenCalledTimes(1);
    expect(w.plugin.send).not.toHaveBeenCalled();
    expect(w.conversations.saveOutbound).not.toHaveBeenCalled();
  });

  it('nunca encola más de 3 burbujas', async () => {
    const w = setup();
    await w.send(['a', 'b', 'c', 'd', 'e'].join('\n\n'));
    const call = w.outbox.enqueue.mock.calls[0] as unknown as [
      { bubbles: string[] },
    ];
    expect(call[0].bubbles).toHaveLength(3);
  });

  it('sin tenantId en el evento lo resuelve por la conexión', async () => {
    const w = setup();
    await w.send('Hola', { tenantId: undefined });
    expect(w.outbox.tenantOf).toHaveBeenCalledWith('conn');
    expect(w.outbox.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1' }),
    );
  });

  it('si la bandeja falla, informa el error y no envía por otra vía', async () => {
    const w = setup({ enqueueFails: true });
    const result = await w.send('Hola');
    expect(result).toEqual({ success: false, error: 'db caída' });
    expect(w.plugin.send).not.toHaveBeenCalled();
    expect(w.dispatcher.kick).not.toHaveBeenCalled();
  });

  it('el mensaje de una persona del equipo se envía directo, sin dividir, y activa el takeover', async () => {
    const w = setup();
    const result = await w.send('Uno.\n\nDos.', { sentBy: 'human' });
    expect(result).toEqual({ success: true });
    expect(w.sent).toEqual(['Uno.\n\nDos.']);
    expect(w.outbox.enqueue).not.toHaveBeenCalled();
    expect(w.conversations.saveHumanOutbound).toHaveBeenCalledWith(
      'c1',
      'Uno.\n\nDos.',
      'conn',
    );
  });
});
