import { IntentHandler, IntentTurn } from 'src/bot/intent/IntentHandler';
import { IntentResolver } from 'src/bot/intent/IntentResolver';
import { IntentMetricsService } from 'src/bot/intent/intent-metrics.service';
import { DEFAULT_INTENTS, IntentId } from 'src/bot/intent/intent-catalog';

type Mode = 'OFF' | 'SHADOW' | 'ACTIVE';

const TOOLS = [
  'consultar_cliente',
  'enlace_cancelacion',
  'info_negocio',
  'reservas_proximas',
  'depositos_pendientes',
  'listar_tratamientos',
  'pasar_a_persona',
].map((name) => ({
  definitionId: `def-${name}`,
  spec: { name },
  injectPhoneParamName: ['info_negocio', 'listar_tratamientos'].includes(name)
    ? null
    : 'phone',
  pausesBotMinutes: name === 'pasar_a_persona' ? 240 : null,
  readOnly: name !== 'pasar_a_persona',
}));

const FUTURE = '2026-11-02T15:00:00.000Z';

function build(options: {
  mode?: Mode | Partial<Record<IntentId, Mode>>;
  responses?: Record<string, { status: string; body?: unknown }>;
  cooldown?: number;
}) {
  const sent: string[] = [];
  const toolCalls: Array<{ tool: string; params: unknown; phone?: string }> =
    [];
  const paused: Array<{ minutes: number; reason: string }> = [];
  const remembered: unknown[] = [];
  const notified: unknown[][] = [];
  const responses = options.responses ?? {};

  const modeFor = (id: IntentId): Mode =>
    typeof options.mode === 'string'
      ? options.mode
      : (options.mode?.[id] ?? 'ACTIVE');

  const metrics = new IntentMetricsService();
  (metrics as unknown as { logger: object }).logger = { log: jest.fn() };

  const handler = new IntentHandler(
    new IntentResolver(),
    {
      forBot: () =>
        Promise.resolve({
          modeOf: modeFor,
          variantsOf: (intent: any, key: string) => intent.variants[key] ?? [],
          cooldownOf: (intent: any) =>
            options.cooldown ?? intent.cooldownSeconds,
          agent: 'Sofía',
          business: 'Leonice Spa',
        }),
    } as never,
    metrics,
    {
      execute: jest.fn((req: any) => {
        const tool = TOOLS.find((t) => t.definitionId === req.toolDefinitionId)!
          .spec.name;
        toolCalls.push({
          tool,
          params: req.params,
          phone: req.injectedPhone,
        });
        const r = responses[tool] ?? { status: 'SUCCESS', body: {} };
        return Promise.resolve({
          status: r.status,
          responseBody: r.body ?? {},
          httpStatus: 200,
          errorDetail: r.status === 'SUCCESS' ? null : 'falló',
          invocationId: null,
        });
      }),
    } as never,
    {
      pauseBot: (_id: string, minutes: number, reason: string) => {
        paused.push({ minutes, reason });
        return Promise.resolve(new Date());
      },
      appendActionMemory: (_id: string, entry: unknown) => {
        remembered.push(entry);
        return Promise.resolve();
      },
    } as never,
    {
      notifyToolFailure: (...args: unknown[]) => {
        notified.push(args);
        return Promise.resolve(true);
      },
    } as never,
  );

  const turn = (text: string, extra: Partial<IntentTurn> = {}): IntentTurn => ({
    tenantId: 't',
    botConfigId: 'bot',
    conversationId: 'conv-1',
    phoneNumber: '573001112233',
    connectionId: 'conn',
    text,
    hasImage: false,
    turnId: 'turn-1',
    lastBotMessage: null,
    loadTools: () => Promise.resolve(TOOLS as never),
    send: (reply) => {
      sent.push(reply);
      return Promise.resolve();
    },
    ...extra,
  });

  return {
    handler,
    turn,
    sent,
    toolCalls,
    paused,
    remembered,
    notified,
    metrics,
  };
}

describe('IntentHandler', () => {
  it('SOMBRA clasifica y registra, pero no responde ni llama herramientas', async () => {
    const w = build({ mode: 'SHADOW' });
    const out = await w.handler.handle(w.turn('quiero cancelar mi cita'));
    expect(out.handled).toBe(false);
    expect(w.sent).toHaveLength(0);
    expect(w.toolCalls).toHaveLength(0);
    expect(w.metrics.snapshot()['cancel_booking:shadow']).toBe(1);
  });

  it('APAGADA no hace nada', async () => {
    const w = build({ mode: 'OFF' });
    expect((await w.handler.handle(w.turn('gracias'))).handled).toBe(false);
    expect(w.sent).toHaveLength(0);
  });

  it('cancelar: llama enlace_cancelacion con el teléfono del chat y responde con el enlace, 0 IA', async () => {
    const w = build({
      responses: {
        enlace_cancelacion: {
          status: 'SUCCESS',
          body: {
            hasUpcoming: true,
            url: 'https://spa.test/cancelar/abc.def',
            treatment: 'Masaje relajante',
            scheduledStart: FUTURE,
            sameDayCount: 1,
            upcomingDays: 1,
          },
        },
      },
    });
    const out = await w.handler.handle(w.turn('Quiero cancelar mi cita'));
    expect(out.handled).toBe(true);
    expect(w.toolCalls).toEqual([
      { tool: 'enlace_cancelacion', params: {}, phone: '573001112233' },
    ]);
    expect(w.sent[0]).toContain('https://spa.test/cancelar/abc.def');
    expect(w.sent[0]).toContain('Masaje relajante');
    expect(w.sent[0]).toMatch(/lunes 2 de noviembre a las 10:00 am/);
    expect(w.remembered).toHaveLength(1);
  });

  it('el teléfono lo pone el sistema: el texto de la clienta no se pasa como parámetro', async () => {
    const w = build({});
    await w.handler.handle(w.turn('cancela mi cita 573009998877'));
    expect(w.toolCalls.every((c) => c.phone === '573001112233')).toBe(true);
  });

  it('"no puedo ir" ofrece las dos opciones: enlace y reagendar', async () => {
    const w = build({
      responses: {
        enlace_cancelacion: {
          status: 'SUCCESS',
          body: {
            hasUpcoming: true,
            url: 'https://spa.test/cancelar/x.y',
            treatment: 'Facial',
            scheduledStart: FUTURE,
            sameDayCount: 1,
            upcomingDays: 1,
          },
        },
      },
    });
    await w.handler.handle(w.turn('ya no puedo ir'));
    expect(w.sent[0]).toMatch(/1\) Cancelarla/);
    expect(w.sent[0]).toMatch(/2\) Reagendarla/);
  });

  it('sin citas próximas responde sin inventar un enlace', async () => {
    const w = build({
      responses: {
        enlace_cancelacion: { status: 'SUCCESS', body: { hasUpcoming: false } },
      },
    });
    await w.handler.handle(w.turn('quiero cancelar mi cita'));
    expect(w.sent[0]).toMatch(/No encuentro citas próximas/);
    expect(w.sent[0]).not.toMatch(/https?:/);
  });

  it('un enlace que no es http(s) cae a la IA', async () => {
    const w = build({
      responses: {
        enlace_cancelacion: {
          status: 'SUCCESS',
          body: {
            hasUpcoming: true,
            url: 'javascript:alert(1)',
            treatment: 'Facial',
            scheduledStart: FUTURE,
          },
        },
      },
    });
    const out = await w.handler.handle(w.turn('quiero cancelar mi cita'));
    expect(out.handled).toBe(false);
    expect(w.sent).toHaveLength(0);
  });

  it.each(['BUSINESS_ERROR', 'TECHNICAL_ERROR'])(
    'si la herramienta falla (%s) cae a la IA, nunca a silencio',
    async (status) => {
      const w = build({ responses: { enlace_cancelacion: { status } } });
      const out = await w.handler.handle(w.turn('quiero cancelar mi cita'));
      expect(out.handled).toBe(false);
      expect(w.sent).toHaveLength(0);
      expect(w.notified).toHaveLength(status === 'TECHNICAL_ERROR' ? 1 : 0);
    },
  );

  it('si la herramienta no existe en el bot cae a la IA', async () => {
    const w = build({});
    const out = await w.handler.handle(
      w.turn('quiero cancelar mi cita', {
        loadTools: () => Promise.resolve([]),
      }),
    );
    expect(out.handled).toBe(false);
  });

  it('con un LID (sin teléfono verificado) las herramientas de identidad caen a la IA', async () => {
    const w = build({});
    const out = await w.handler.handle(
      w.turn('quiero cancelar mi cita', { phoneNumber: '99887766@lid' }),
    );
    expect(out.handled).toBe(false);
    expect(w.toolCalls).toHaveLength(0);
  });

  it('un saludo con LID se responde igual con el texto genérico', async () => {
    const w = build({});
    const out = await w.handler.handle(
      w.turn('hola', { phoneNumber: '99887766@lid' }),
    );
    expect(out.handled).toBe(true);
    expect(w.sent[0]).toMatch(/Soy Sofía de Leonice Spa/);
  });

  it('saluda por el nombre a una clienta registrada', async () => {
    const w = build({
      responses: {
        consultar_cliente: {
          status: 'SUCCESS',
          body: { registered: true, firstName: 'MARÍA' },
        },
      },
    });
    await w.handler.handle(w.turn('Hola'));
    expect(w.sent[0]).toContain('María');
  });

  it('saludo a una no registrada: texto genérico', async () => {
    const w = build({
      responses: {
        consultar_cliente: { status: 'SUCCESS', body: { registered: false } },
      },
    });
    await w.handler.handle(w.turn('Hola'));
    expect(w.sent[0]).not.toContain('{{');
    expect(w.sent[0]).toMatch(/Sofía/);
  });

  it('rota las variantes y el enfriamiento evita repetir la misma plantilla seguida', async () => {
    const w = build({ cooldown: 0 });
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      await w.handler.handle(w.turn('gracias'));
      seen.add(w.sent[i]);
    }
    expect(seen.size).toBe(3);

    const cooled = build({ cooldown: 60 });
    expect((await cooled.handler.handle(cooled.turn('gracias'))).handled).toBe(
      true,
    );
    const second = await cooled.handler.handle(cooled.turn('gracias'));
    expect(second.handled).toBe(false);
    expect(cooled.sent).toHaveLength(1);
  });

  it('con una pregunta abierta del bot, "gracias" va a la IA', async () => {
    const w = build({});
    const out = await w.handler.handle(
      w.turn('gracias', {
        lastBotMessage: { content: '¿Confirmas la cita?', at: new Date() },
      }),
    );
    expect(out.handled).toBe(false);
  });

  it('pedir una persona: llama pasar_a_persona, pausa el bot y avisa a la clienta', async () => {
    const w = build({});
    const out = await w.handler.handle(w.turn('quiero hablar con una persona'));
    expect(out.handled).toBe(true);
    expect(w.toolCalls[0].tool).toBe('pasar_a_persona');
    expect(w.toolCalls[0].params).toMatchObject({
      reason: expect.stringContaining('pidió hablar con una persona'),
    });
    expect(w.paused).toEqual([
      { minutes: 240, reason: 'Traspaso a una persona (human_request)' },
    ]);
    expect(w.sent[0]).toMatch(/equipo/);
  });

  it('si el traspaso falla NO se pausa el bot y el turno sigue a la IA', async () => {
    const w = build({
      responses: { pasar_a_persona: { status: 'TECHNICAL_ERROR' } },
    });
    const out = await w.handler.handle(w.turn('quiero hablar con una persona'));
    expect(out.handled).toBe(false);
    expect(w.paused).toHaveLength(0);
  });

  it('horario: renderiza el horario semanal sin llamar a la IA', async () => {
    const w = build({
      responses: {
        info_negocio: {
          status: 'SUCCESS',
          body: {
            weeklySchedule: [
              { day: 'lunes', hours: '9:00 a. m. a 6:00 p. m.' },
              { day: 'domingo', hours: 'cerrado' },
            ],
          },
        },
      },
    });
    await w.handler.handle(w.turn('¿a qué hora abren?'));
    expect(w.sent[0]).toContain('• Lunes: 9:00 a. m. a 6:00 p. m.');
    expect(w.sent[0]).toContain('• Domingo: cerrado');
  });

  it('dirección vacía en el backend cae a la IA en vez de responder vacío', async () => {
    const w = build({
      responses: {
        info_negocio: { status: 'SUCCESS', body: { address: null } },
      },
    });
    const out = await w.handler.handle(w.turn('dirección'));
    expect(out.handled).toBe(false);
    expect(w.sent).toHaveLength(0);
  });

  it('mis citas: lista las citas', async () => {
    const w = build({
      responses: {
        reservas_proximas: {
          status: 'SUCCESS',
          body: {
            days: [
              {
                date: '2026-11-02',
                reservations: [{ treatment: 'Masaje', scheduledStart: FUTURE }],
              },
            ],
          },
        },
      },
    });
    await w.handler.handle(w.turn('mis citas'));
    expect(w.sent[0]).toContain('• Masaje — lunes 2 de noviembre');
  });

  it('abonos: sin pendientes lo dice; con pendientes los lista', async () => {
    const none = build({
      responses: {
        depositos_pendientes: {
          status: 'SUCCESS',
          body: { clientName: 'Ana', candidates: [] },
        },
      },
    });
    await none.handler.handle(none.turn('estado de mi abono'));
    expect(none.sent[0]).toMatch(/No tienes abonos pendientes/);

    const some = build({
      responses: {
        depositos_pendientes: {
          status: 'SUCCESS',
          body: {
            clientName: 'Ana',
            candidates: [{ treatmentName: 'Facial', scheduledStart: FUTURE }],
          },
        },
      },
    });
    await some.handler.handle(some.turn('estado de mi abono'));
    expect(some.sent[0]).toContain('• Facial');
    expect(some.sent[0]).toMatch(/comprobante/);
  });

  it('tratamientos: lista con precios y nota de rango; más de 25 cae a la IA', async () => {
    const rows = [
      { name: 'Masaje', category: 'Corporales', price: '$150.000' },
      {
        name: 'Alisado',
        category: 'Capilares',
        price: '$200.000 – $400.000',
        priceIsRange: true,
      },
    ];
    const w = build({
      responses: { listar_tratamientos: { status: 'SUCCESS', body: rows } },
    });
    await w.handler.handle(w.turn('qué tratamientos tienen'));
    expect(w.sent[0]).toContain('*Corporales*\n• Masaje — $150.000');
    expect(w.sent[0]).toContain('*Capilares*\n• Alisado');
    expect(w.sent[0]).toMatch(/se confirman en la valoración/);

    const many = build({
      responses: {
        listar_tratamientos: {
          status: 'SUCCESS',
          body: Array.from({ length: 26 }, (_, i) => ({ name: `T${i}` })),
        },
      },
    });
    expect(
      (await many.handler.handle(many.turn('lista de precios'))).handled,
    ).toBe(false);
  });

  it('un error inesperado nunca se propaga: el turno sigue a la IA', async () => {
    const w = build({});
    const out = await w.handler.handle(
      w.turn('gracias', {
        send: () => Promise.reject(new Error('canal caído')),
      }),
    );
    expect(out.handled).toBe(false);
    expect(w.metrics.snapshot().error).toBe(1);
  });

  it('con imagen no se clasifica', async () => {
    const w = build({});
    const out = await w.handler.handle(w.turn('gracias', { hasImage: true }));
    expect(out.handled).toBe(false);
    expect(w.sent).toHaveLength(0);
  });

  it('registra la señal de falso positivo cuando tras la plantilla pide una persona o repite', async () => {
    const w = build({});
    await w.handler.handle(w.turn('gracias'));
    await w.handler.handle(w.turn('quiero hablar con una persona'));
    expect(
      w.metrics.snapshot()['false-positive-signal:courtesy:asked-human'],
    ).toBe(1);

    const r = build({ cooldown: 0 });
    await r.handler.handle(r.turn('gracias'));
    await r.handler.handle(r.turn('gracias'));
    expect(
      r.metrics.snapshot()['false-positive-signal:courtesy:repeated'],
    ).toBe(1);
  });

  it('el catálogo por defecto tiene un renderizador para cada intención', () => {
    const { RENDERERS } = jest.requireActual('src/bot/intent/intent-render');
    for (const intent of DEFAULT_INTENTS) {
      expect(RENDERERS[intent.id]).toBeDefined();
    }
  });
});
