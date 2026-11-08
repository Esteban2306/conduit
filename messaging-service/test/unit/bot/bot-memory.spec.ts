// BotRouter importa Baileys (solo ESM); la prueba no usa WhatsApp real.
jest.mock('@whiskeysockets/baileys', () => ({
  __esModule: true,
  default: jest.fn(),
  downloadMediaMessage: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
  fetchLatestBaileysVersion: jest.fn(),
  BufferJSON: {},
  initAuthCreds: jest.fn(),
  proto: {},
}));

import { isIgnorableAcknowledgement } from 'src/bot/router/acknowledgement';
import { ConversationService } from 'src/bot/conversation/ConversationService';
import { ContextBuilder } from 'src/bot/prompt/ContextBuilder';
import { BotRouter } from 'src/bot/router/BotRouter';

jest.mock('src/channels/whatsapp/baileys/human-timing', () => ({
  ...jest.requireActual('src/channels/whatsapp/baileys/human-timing'),
  jittered: (ms: number) => ms,
  readDelayMs: () => 500,
}));

describe('isIgnorableAcknowledgement', () => {
  it.each(['sí', 'si', 'no', 'ok', 'listo', 'dale', 'Sí.', '👍'])(
    'procesa "%s" cuando el bot hizo una pregunta',
    (text) => {
      expect(
        isIgnorableAcknowledgement(text, '¿Confirmas tu cita del 15 a las 8?'),
      ).toBe(false);
    },
  );

  it('ignora "ok" si el bot no preguntó nada', () => {
    expect(
      isIgnorableAcknowledgement('ok', 'Tu cita quedó agendada para el 15.'),
    ).toBe(true);
  });

  it('con la tarea terminada ignora el relleno aunque el bot haya cerrado con una pregunta', () => {
    expect(isIgnorableAcknowledgement('ok', '¿Algo más?', false, true)).toBe(
      true,
    );
    expect(
      isIgnorableAcknowledgement('gracias', '¿Algo más?', false, true),
    ).toBe(true);
    expect(isIgnorableAcknowledgement('ok', '¿Algo más?', false, false)).toBe(
      false,
    );
  });

  it('ignora "gracias" al cierre', () => {
    expect(isIgnorableAcknowledgement('Gracias!', 'Te esperamos 😊')).toBe(
      true,
    );
  });

  it('no ignora nada si hay un lote del cliente sin responder', () => {
    expect(isIgnorableAcknowledgement('ok', 'Hola', true)).toBe(false);
  });

  it('no ignora mensajes con contenido', () => {
    expect(isIgnorableAcknowledgement('sí, para el viernes', null)).toBe(false);
  });

  it('procesa "sí" como respuesta a un recordatorio con pregunta', () => {
    expect(
      isIgnorableAcknowledgement(
        'si',
        'Hola Ana, te recordamos tu cita mañana a las 9:00 a. m. ¿Nos confirmas tu asistencia?',
      ),
    ).toBe(false);
  });
});

describe('ConversationService.getConversationForAI', () => {
  function serviceWith(
    messages: Array<[string, string, boolean?, string?, string?]>,
    context: Record<string, unknown> = {},
    queued: Array<{ groupId: string; content: string; createdAt: Date }> = [],
  ) {
    const rows = messages.map(
      ([direction, content, hasImage, at, processedBy], index) => ({
        direction,
        processedBy,
        content,
        hasImage: hasImage ?? false,
        createdAt: new Date(at ?? Date.UTC(2026, 9, 10, 12, index)),
      }),
    );
    const prisma = {
      conversation: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'c1',
          context: { memoriaAcciones: [], ...context },
          summary: 'Quiere reservar spa capilar.',
          currentStep: null,
          lastIntent: null,
        }),
      },
      botMessage: {
        // El servicio pide orden descendente.
        findMany: jest.fn().mockResolvedValue([...rows].reverse()),
      },
      outboundReply: { findMany: jest.fn().mockResolvedValue(queued) },
    };
    return new ConversationService(
      prisma as any,
      { publish: jest.fn() } as any,
    );
  }

  it('una respuesta en la bandeja de salida cuenta como dicha: no queda nada pendiente y el modelo la ve', async () => {
    const service = serviceWith(
      [
        ['INBOUND', 'hola', false, '2026-10-10T12:00:00.000Z'],
        ['INBOUND', 'quiero reservar', false, '2026-10-10T12:01:00.000Z'],
      ],
      {},
      [
        {
          groupId: 'g1',
          content: 'Claro, ¿para qué día?',
          createdAt: new Date('2026-10-10T12:02:00.000Z'),
        },
        {
          groupId: 'g1',
          content: 'Tengo el viernes libre.',
          createdAt: new Date('2026-10-10T12:02:00.001Z'),
        },
      ],
    );

    const data = await service.getConversationForAI('c1', 6);

    expect(data.pending).toEqual([]);
    expect(data.history.map((h) => h.role)).toEqual(['user', 'assistant']);
    expect(data.history[1].content).toBe(
      'Claro, ¿para qué día?\n\nTengo el viernes libre.',
    );
  });

  it('un mensaje que llegó demasiado tarde para responderse solo no queda pendiente para el bot', async () => {
    const service = serviceWith([
      ['INBOUND', 'hola', false, undefined, 'expired_reply'],
      ['INBOUND', '¿siguen ahí?', false, undefined, 'expired_reply'],
    ]);

    const data = await service.getConversationForAI('c1', 6);

    expect(data.pending).toEqual([]);
  });

  it('separa lo pendiente (todo lo escrito desde la última respuesta)', async () => {
    const service = serviceWith([
      ['INBOUND', 'hola'],
      ['OUTBOUND', '¡Hola! ¿En qué te ayudo?'],
      ['INBOUND', 'quiero reservar'],
      ['INBOUND', 'para el viernes'],
      ['INBOUND', '[imagen]', true],
    ]);

    const data = await service.getConversationForAI('c1', 6);

    expect(data.pending.map((p) => p.content)).toEqual([
      'quiero reservar',
      'para el viernes',
      '[imagen]',
    ]);
    expect(data.pending.some((p) => p.hasImage)).toBe(true);
    expect(data.history.map((h) => h.role)).toEqual(['user', 'assistant']);
    expect(data.summary).toBe('Quiere reservar spa capilar.');
  });

  it('tras un reinicio no muestra al modelo nada anterior al corte', async () => {
    const cut = Date.UTC(2026, 9, 10, 12, 1, 30);
    const service = serviceWith(
      [
        ['INBOUND', 'quiero reservar'],
        ['OUTBOUND', '¿Para qué día?'],
        ['INBOUND', 'hola de nuevo'],
      ],
      { closedAt: new Date(Date.UTC(2026, 9, 10, 12, 1)).toISOString() },
    );
    const data = await service.getConversationForAI('c1', 6);
    void cut;
    expect(data.history).toEqual([]);
    expect(data.pending.map((p) => p.content)).toEqual(['hola de nuevo']);
  });

  it('pasa aparte el recordatorio previo para que el historial empiece por el cliente', async () => {
    const service = serviceWith([
      ['OUTBOUND', 'Te recordamos tu cita mañana. ¿Nos confirmas?'],
      ['INBOUND', 'sí'],
      ['OUTBOUND', '¡Perfecto, te esperamos!'],
      ['INBOUND', 'a qué hora era?'],
    ]);

    const data = await service.getConversationForAI('c1', 6);

    expect(data.leadingBotMessages).toEqual([
      'Te recordamos tu cita mañana. ¿Nos confirmas?',
    ]);
    expect(data.history[0].role).toBe('user');
    expect(data.pending.map((p) => p.content)).toEqual(['a qué hora era?']);
  });

  it('no responde lo que el cliente escribió antes de cerrar la conversación', async () => {
    const service = serviceWith(
      [
        ['INBOUND', 'hola'],
        ['OUTBOUND', '¡Hola! ¿En qué te ayudo?'],
        ['INBOUND', 'gracias', false, '2026-10-10T12:02:00Z'],
        ['INBOUND', 'quiero otra cita', false, '2026-10-10T13:00:00Z'],
      ],
      { closedAt: '2026-10-10T12:30:00Z' },
    );

    const data = await service.getConversationForAI('c1', 6);

    expect(data.pending.map((p) => p.content)).toEqual(['quiero otra cita']);
  });

  it('no deja nada pendiente si el cliente no ha escrito tras el cierre', async () => {
    const service = serviceWith(
      [
        ['INBOUND', 'hola'],
        ['OUTBOUND', '¡Hola!'],
        ['INBOUND', 'ok gracias', false, '2026-10-10T12:02:00Z'],
      ],
      { closedAt: '2026-10-10T12:30:00Z' },
    );

    const data = await service.getConversationForAI('c1', 6);

    expect(data.pending).toEqual([]);
  });

  it('no recorta mensajes normales (antes: 120 caracteres)', async () => {
    const long = 'Horarios disponibles: ' + '8:00, 9:00, 10:00, '.repeat(20);
    const service = serviceWith([
      ['INBOUND', 'qué horarios hay?'],
      ['OUTBOUND', long],
      ['INBOUND', 'el de las 10'],
    ]);

    const data = await service.getConversationForAI('c1', 6);
    expect(data.history[1].content).toBe(long);
  });
});

describe('ContextBuilder — memoria de acciones', () => {
  it('incluye los resultados reales de las herramientas', () => {
    const { block } = new ContextBuilder().build(
      {
        memoriaAcciones: [
          {
            herramienta: 'reservar',
            parametros: '{"treatments":["t1"]}',
            estado: 'SUCCESS',
            resultado: '{"reservations":[{"id":"res-123"}]}',
            en: '2026-10-10T15:00:00.000Z',
          },
        ],
        resumenHasta: '2026-10-10T14:00:00.000Z',
      },
      'Quiere reservar spa capilar el viernes.',
    );

    expect(block).toContain('Acciones ya realizadas');
    expect(block).toContain('res-123');
    expect(block).toContain('Quiere reservar spa capilar el viernes.');
    expect(block).not.toContain('resumenHasta');
  });
});

describe('BotRouter — nunca deja mensajes sin responder', () => {
  function router() {
    const conversationService = {
      acquireLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };
    const r = Object.create(BotRouter.prototype);
    Object.assign(r, {
      logger: { debug: jest.fn(), warn: jest.fn(), log: jest.fn() },
      processingConversations: new Set<string>(),
      rerunRequested: new Set<string>(),
      readGates: new Map<string, Promise<void>>(),
      conversationService,
      systemPause: { isPaused: jest.fn().mockResolvedValue(false) },
      debouncer: { hasPending: jest.fn(), debounce: jest.fn() },
    });
    return r;
  }

  it('si llegan mensajes mientras procesa, hace otra pasada al terminar', async () => {
    const r = router();
    const turn = { conversationId: 'c1', sessionKey: 'k' } as any;
    let release!: () => void;
    let calls = 0;

    r.answerPending = jest.fn(async () => {
      calls++;
      if (calls === 1) await new Promise<void>((res) => (release = res));
    });

    const first = r.respond(turn);
    await new Promise((res) => setImmediate(res));

    await r.respond(turn); // llega otro lote mientras el primero sigue
    expect(r.answerPending).toHaveBeenCalledTimes(1);

    release();
    await first;

    expect(r.answerPending).toHaveBeenCalledTimes(2);
    expect(r.conversationService.releaseLock).toHaveBeenCalledTimes(1);
  });
});
