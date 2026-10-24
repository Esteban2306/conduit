jest.mock('src/channels/whatsapp/baileys/BaileysPlugin', () => ({
  BaileysPlugin: class {},
}));

import { BaileysMessageSender } from 'src/channels/whatsapp/baileys/BaileysMessageSender';
import { EVENT_TYPES } from 'src/infra/events/constants/event.types';
import { ReplyMetricsService } from 'src/bot/router/reply-metrics.service';

function setup(sendImpl?: (payload: { content: string }) => unknown) {
  const sent: string[] = [];
  const plugin = {
    send: jest.fn((payload: { content: string }) => {
      sent.push(payload.content);
      return Promise.resolve(
        sendImpl?.(payload) ?? { success: true, providerMessageId: 'id' },
      );
    }),
  };
  const conversations = {
    saveOutbound: jest.fn().mockResolvedValue(undefined),
    saveHumanOutbound: jest.fn().mockResolvedValue(undefined),
  };
  const eventBus = { publish: jest.fn() };
  const metrics = new ReplyMetricsService();
  const sender = new BaileysMessageSender(
    plugin as never,
    conversations as never,
    eventBus as never,
    metrics,
  );
  const send = (content: string, extra: Record<string, unknown> = {}) =>
    sender.handleSendRequested({
      payload: {
        phoneNumber: '573000000001',
        content,
        conversationId: 'c1',
        connectionId: 'conn',
        ...extra,
      },
    } as never);
  return { sent, plugin, conversations, eventBus, metrics, send };
}

describe('BaileysMessageSender', () => {
  it('propiedad: ningún texto vacío o en blanco llega al canal, venga de donde venga', async () => {
    const blanks = ['', ' ', '\n', '\t\n ', '​', '​\n‍', '﻿', ' '];
    const w = setup();
    for (const blank of blanks) {
      for (const sentBy of [undefined, 'human']) {
        const result = await w.send(blank, { sentBy });
        expect(result).toEqual({ success: false, error: 'EMPTY_MESSAGE' });
      }
    }
    expect(w.plugin.send).not.toHaveBeenCalled();
    expect(w.conversations.saveOutbound).not.toHaveBeenCalled();
    expect(w.metrics.snapshot().blockedEmpty).toBe(blanks.length * 2);
  });

  it('manda una respuesta de un párrafo como una sola burbuja', async () => {
    const w = setup();
    await w.send('Hola, soy Sofía.');
    expect(w.sent).toEqual(['Hola, soy Sofía.']);
    expect(w.conversations.saveOutbound).toHaveBeenCalledWith(
      'c1',
      'Hola, soy Sofía.',
      expect.anything(),
    );
  });

  it('divide la respuesta por párrafo y guarda el historial como un solo mensaje', async () => {
    const w = setup();
    const result = await w.send('Tengo cupo el lunes.\n\n¿Te sirve a las 9?');
    expect(result).toEqual({ success: true });
    expect(w.sent).toEqual(['Tengo cupo el lunes.', '¿Te sirve a las 9?']);
    expect(w.conversations.saveOutbound).toHaveBeenCalledTimes(1);
    expect(w.conversations.saveOutbound).toHaveBeenCalledWith(
      'c1',
      'Tengo cupo el lunes.\n\n¿Te sirve a las 9?',
      expect.anything(),
    );
  });

  it('nunca manda más de 3 burbujas', async () => {
    const w = setup();
    await w.send(['a', 'b', 'c', 'd', 'e'].join('\n\n'));
    expect(w.sent).toHaveLength(3);
  });

  it('el mensaje de una persona del equipo no se divide', async () => {
    const w = setup();
    await w.send('Uno.\n\nDos.', { sentBy: 'human' });
    expect(w.sent).toEqual(['Uno.\n\nDos.']);
    expect(w.conversations.saveHumanOutbound).toHaveBeenCalledWith(
      'c1',
      'Uno.\n\nDos.',
      'conn',
    );
  });

  it('si falla la segunda burbuja, guarda solo lo entregado y no marca el envío como fallido', async () => {
    let calls = 0;
    const w = setup(() =>
      ++calls === 2 ? { success: false, error: 'boom' } : { success: true },
    );
    const result = await w.send('Primera.\n\nSegunda.');
    expect(result).toEqual({ success: true });
    expect(w.conversations.saveOutbound).toHaveBeenCalledWith(
      'c1',
      'Primera.',
      expect.anything(),
    );
  });

  it('si falla la primera burbuja, el envío falla y no guarda nada', async () => {
    const w = setup(() => ({ success: false, error: 'sin conexión' }));
    const result = await w.send('Primera.\n\nSegunda.');
    expect(result).toEqual({ success: false, error: 'sin conexión' });
    expect(w.conversations.saveOutbound).not.toHaveBeenCalled();
    expect(w.eventBus.publish).toHaveBeenCalledWith(
      EVENT_TYPES.CHANNEL_SEND_FAILED,
      expect.anything(),
    );
  });
});
