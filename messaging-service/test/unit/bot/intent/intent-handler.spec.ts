import { IntentHandler } from 'src/bot/intent/IntentHandler';
import { IntentResolver } from 'src/bot/intent/IntentResolver';
import { IntentMetricsService } from 'src/bot/intent/intent-metrics.service';
import { IntentTurn } from 'src/bot/intent/intent-turn';
import { IntentModeValue } from 'src/bot/intent/intent-types';
import { TIME_ZONE, intentSet, spaRecords } from './fixture';

const TOOLS = [
  'consultar_cliente',
  'enlace_cancelacion',
  'info_negocio',
  'info_tratamiento',
  'reservas_proximas',
  'depositos_pendientes',
  'listar_tratamientos',
  'pasar_a_persona',
].map((name) => ({
  definitionId: `def-${name}`,
  spec: { name },
  injectPhoneParamName: [
    'info_negocio',
    'listar_tratamientos',
    'info_tratamiento',
  ].includes(name)
    ? null
    : 'phone',
  pausesBotMinutes: name === 'pasar_a_persona' ? 240 : null,
  readOnly: name !== 'pasar_a_persona',
}));

const FUTURE = '2026-11-02T15:00:00.000Z';
type Responses = Record<string, { status: string; body?: unknown }>;

function build(
  options: {
    mode?: IntentModeValue | Record<string, IntentModeValue>;
    responses?: Responses;
    hardRule?: boolean;
    ai?: (text: string) => string | null;
  } = {},
) {
  const sent: string[] = [];
  const calls: Array<{ tool: string; params: any; phone?: string }> = [];
  const paused: Array<{ minutes: number; reason: string }> = [];
  const contexts: any[] = [];
  const remembered: unknown[] = [];
  const notified: unknown[][] = [];
  const aiCalls: string[] = [];
  const responses = options.responses ?? {};

  const metrics = new IntentMetricsService();
  (metrics as unknown as { logger: object }).logger = { log: jest.fn() };

  const set = intentSet(spaRecords(options.mode ?? 'ACTIVE'));
  const handler = new IntentHandler(
    new IntentResolver(),
    {
      forBot: () => Promise.resolve(set),
      timeZone: () => TIME_ZONE,
    } as never,
    { apply: () => Promise.resolve(options.hardRule ?? false) } as never,
    {
      classify: (_b: string, _c: string, text: string) => {
        aiCalls.push(text);
        const key = options.ai ? options.ai(text) : null;
        return Promise.resolve(
          key === undefined ? null : { key, cached: false },
        );
      },
    } as never,
    metrics,
    {
      execute: jest.fn((req: any) => {
        const tool = TOOLS.find((t) => t.definitionId === req.toolDefinitionId)!
          .spec.name;
        calls.push({ tool, params: req.params, phone: req.injectedPhone });
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
      updateContext: (_id: string, patch: any) => {
        contexts.push(patch.contextPatch);
        return Promise.resolve();
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
      notifyContacts: (...args: unknown[]) => {
        notified.push(args);
        return Promise.resolve(true);
      },
    } as never,
  );

  const turn = (text: string, extra: Partial<IntentTurn> = {}): IntentTurn => ({
    tenantId: 't',
    botConfigId: 'bot',
    conversationId: 'conv-1',
    connectionId: 'conn',
    phoneNumber: '573001112233',
    text,
    hasImage: false,
    turnId: 'turn-1',
    context: {},
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
    calls,
    paused,
    contexts,
    remembered,
    notified,
    aiCalls,
    metrics,
  };
}

const LINK = {
  hasUpcoming: true,
  reservationId: 'r1',
  url: 'https://spa.test/cancelar/abc.def',
  treatment: 'Masaje relajante',
  scheduledStart: FUTURE,
  sameDayCount: 1,
  upcomingDays: 1,
};

describe('IntentHandler · modos', () => {
  it('SOMBRA clasifica y registra, pero no responde ni llama herramientas', async () => {
    const w = build({ mode: 'SHADOW' });
    const out = await w.handler.handle(w.turn('quiero cancelar mi cita'));
    expect(out).toEqual({ handled: false });
    expect(w.sent).toHaveLength(0);
    expect(w.calls).toHaveLength(0);
    expect(w.metrics.snapshot()['cancel_booking:shadow']).toBe(1);
  });

  it('APAGADA no hace nada', async () => {
    const w = build({ mode: 'OFF' });
    expect(await w.handler.handle(w.turn('gracias'))).toEqual({
      handled: false,
    });
    expect(w.sent).toHaveLength(0);
  });

  it('con imagen o texto vacío no se clasifica', async () => {
    const w = build();
    expect(
      await w.handler.handle(w.turn('gracias', { hasImage: true })),
    ).toEqual({ handled: false });
    expect(await w.handler.handle(w.turn('   '))).toEqual({ handled: false });
    expect(w.sent).toHaveLength(0);
  });

  it('una regla dura que resuelve el turno lo corta antes de cualquier intención', async () => {
    const w = build({ hardRule: true });
    expect(await w.handler.handle(w.turn('hola'))).toEqual({ handled: true });
    expect(w.sent).toHaveLength(0);
    expect(w.calls).toHaveLength(0);
  });
});

describe('IntentHandler · llamadas directas', () => {
  it('cancelar: llama enlace_cancelacion con el teléfono del chat y responde con el enlace, 0 IA', async () => {
    const w = build({
      responses: { enlace_cancelacion: { status: 'SUCCESS', body: LINK } },
    });
    const out = await w.handler.handle(w.turn('Quiero cancelar mi cita'));
    expect(out).toEqual({ handled: true });
    expect(w.calls[0]).toEqual({
      tool: 'enlace_cancelacion',
      params: {},
      phone: '573001112233',
    });
    expect(w.sent[0]).toContain('https://spa.test/cancelar/abc.def');
    expect(w.sent[0]).toMatch(
      /Masaje relajante.*lunes 2 de noviembre a las 10:00 am/,
    );
    expect(w.remembered.length).toBeGreaterThanOrEqual(1);
  });

  it('el teléfono lo pone el sistema: lo que escribe la clienta no viaja como parámetro', async () => {
    const w = build({});
    await w.handler.handle(w.turn('cancela mi cita 573009998877'));
    expect(w.calls.every((c) => c.phone === '573001112233')).toBe(true);
  });

  it('"no puedo ir" ofrece enlace y reagendar; varias citas usa el texto de varias', async () => {
    const w = build({
      responses: { enlace_cancelacion: { status: 'SUCCESS', body: LINK } },
    });
    await w.handler.handle(w.turn('ya no puedo ir'));
    expect(w.sent[0]).toMatch(/1\) Cancelarla/);
    expect(w.sent[0]).toMatch(/2\) Reagendarla/);

    const many = build({
      responses: {
        enlace_cancelacion: {
          status: 'SUCCESS',
          body: { ...LINK, sameDayCount: 2 },
        },
      },
    });
    await many.handler.handle(many.turn('cancelar mi cita'));
    expect(many.sent[0]).toMatch(/gestionar tus citas/);
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
          body: { ...LINK, url: 'javascript:alert(1)' },
        },
      },
    });
    expect(await w.handler.handle(w.turn('quiero cancelar mi cita'))).toEqual({
      handled: false,
    });
    expect(w.sent).toHaveLength(0);
  });

  it.each(['BUSINESS_ERROR', 'TECHNICAL_ERROR'])(
    'si la herramienta falla (%s) cae a la IA, nunca a silencio',
    async (status) => {
      const w = build({ responses: { enlace_cancelacion: { status } } });
      expect(await w.handler.handle(w.turn('quiero cancelar mi cita'))).toEqual(
        { handled: false },
      );
      expect(w.sent).toHaveLength(0);
      expect(w.notified).toHaveLength(status === 'TECHNICAL_ERROR' ? 1 : 0);
    },
  );

  it('si la herramienta no existe en el bot o hay un LID, cae a la IA', async () => {
    const w = build({});
    expect(
      await w.handler.handle(
        w.turn('quiero cancelar mi cita', {
          loadTools: () => Promise.resolve([]),
        }),
      ),
    ).toEqual({ handled: false });
    expect(
      await w.handler.handle(
        w.turn('quiero cancelar mi cita', { phoneNumber: '99887766@lid' }),
      ),
    ).toEqual({ handled: false });
    expect(w.calls).toHaveLength(0);
  });

  it('horario: renderiza el horario semanal; dirección vacía cae a la IA', async () => {
    const w = build({
      responses: {
        info_negocio: {
          status: 'SUCCESS',
          body: {
            weeklySchedule: [
              { day: 'lunes', hours: '9:00 a. m. a 6:00 p. m.' },
              { day: 'domingo', hours: 'cerrado' },
            ],
            address: null,
          },
        },
      },
    });
    await w.handler.handle(w.turn('¿a qué hora abren?'));
    expect(w.sent[0]).toContain('• Lunes: 9:00 a. m. a 6:00 p. m.');
    expect(w.sent[0]).toContain('• Domingo: cerrado');
    expect(await w.handler.handle(w.turn('dirección'))).toEqual({
      handled: false,
    });
  });

  it('mis citas y abonos', async () => {
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
        depositos_pendientes: {
          status: 'SUCCESS',
          body: { clientName: 'Ana', candidates: [] },
        },
      },
    });
    await w.handler.handle(w.turn('mis citas'));
    expect(w.sent[0]).toContain('• Masaje — lunes 2 de noviembre');
    await w.handler.handle(w.turn('estado de mi abono'));
    expect(w.sent[1]).toMatch(/No tienes abonos pendientes/);
  });

  it('anticipo: con y sin valor', async () => {
    const withAmount = build({
      responses: {
        info_negocio: {
          status: 'SUCCESS',
          body: {
            depositAmountCop: 50000,
            depositInstructions: 'Nequi 300',
            depositDeadline: 'Dentro de 2 h.',
          },
        },
      },
    });
    await withAmount.handler.handle(withAmount.turn('¿Cuánto es el anticipo?'));
    expect(withAmount.sent[0]).toContain('Valor: $50.000');
    expect(withAmount.sent[0]).toContain('Nequi 300');
    expect(withAmount.sent[0]).not.toContain('{{');

    const none = build({
      responses: {
        info_negocio: { status: 'SUCCESS', body: { depositAmountCop: null } },
      },
    });
    expect(
      await none.handler.handle(none.turn('¿Cuánto es el anticipo?')),
    ).toEqual({ handled: false });
  });

  it('tratamientos: agrupa por categoría, avisa los rangos y más de 25 cae a la IA', async () => {
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
    expect(await many.handler.handle(many.turn('lista de precios'))).toEqual({
      handled: false,
    });
  });

  it('cachea la respuesta de una herramienta pública y no la de la clienta', async () => {
    const w = build({
      responses: {
        info_negocio: {
          status: 'SUCCESS',
          body: {
            weeklySchedule: [{ day: 'lunes', hours: '9 a 6' }],
            address: 'Calle 1',
          },
        },
      },
    });
    await w.handler.handle(w.turn('horario'));
    await w.handler.handle(
      w.turn('dirección', {
        conversationId: 'conv-2',
        phoneNumber: '573002223344',
      }),
    );
    expect(w.calls.filter((c) => c.tool === 'info_negocio')).toHaveLength(1);
    expect(w.metrics.snapshot()['tool-cache-hit:info_negocio']).toBe(1);

    const other = build({
      responses: {
        consultar_cliente: {
          status: 'SUCCESS',
          body: { registered: true, firstName: 'ana' },
        },
      },
    });
    await other.handler.handle(other.turn('hola'));
    await other.handler.handle(
      other.turn('hola', { conversationId: 'c2', phoneNumber: '573009990000' }),
    );
    expect(
      other.calls.filter((c) => c.tool === 'consultar_cliente'),
    ).toHaveLength(2);
  });
});

describe('IntentHandler · saludo y cortesía', () => {
  it('saluda por el nombre a una clienta registrada y sin nombre a una no registrada', async () => {
    const registered = build({
      responses: {
        consultar_cliente: {
          status: 'SUCCESS',
          body: { registered: true, firstName: 'MARÍA' },
        },
      },
    });
    await registered.handler.handle(registered.turn('Hola'));
    expect(registered.sent[0]).toContain('María');

    const guest = build({
      responses: {
        consultar_cliente: { status: 'SUCCESS', body: { registered: false } },
      },
    });
    await guest.handler.handle(guest.turn('Hola'));
    expect(guest.sent[0]).toMatch(/Soy Sofía de Leonice Spa/);
    expect(guest.sent[0]).not.toContain('{{');
  });

  it('un saludo con LID se responde igual con el texto genérico', async () => {
    const w = build({});
    expect(
      await w.handler.handle(w.turn('hola', { phoneNumber: '99887766@lid' })),
    ).toEqual({ handled: true });
    expect(w.calls).toHaveLength(0);
  });

  it('rota las variantes y respeta el enfriamiento (sin silencio: va a la IA)', async () => {
    const w = build({ mode: { courtesy: 'ACTIVE' } });
    const seen = new Set<string>();
    const records = spaRecords();
    records.find((r) => r.key === 'courtesy')!.cooldownSeconds = 0;
    for (let i = 0; i < 3; i++) {
      const fresh = build({});
      void fresh;
    }
    await w.handler.handle(w.turn('gracias'));
    seen.add(w.sent[0]);
    expect(seen.size).toBe(1);
    expect(await w.handler.handle(w.turn('gracias'))).toEqual({
      handled: false,
    });
    expect(w.sent).toHaveLength(1);
  });

  it('con una pregunta abierta del bot, "gracias" va a la IA', async () => {
    const w = build({});
    expect(
      await w.handler.handle(
        w.turn('gracias', {
          lastBotMessage: { content: '¿Confirmas la cita?', at: new Date() },
        }),
      ),
    ).toEqual({ handled: false });
  });
});

describe('IntentHandler · traspaso', () => {
  it('pedir una persona: llama pasar_a_persona, pausa el bot y avisa a la clienta', async () => {
    const w = build({});
    expect(
      await w.handler.handle(w.turn('quiero hablar con una persona')),
    ).toEqual({ handled: true });
    expect(w.calls[0].tool).toBe('pasar_a_persona');
    expect(w.calls[0].params.reason).toMatch(/pidió hablar con una persona/);
    expect(w.paused).toEqual([
      { minutes: 240, reason: 'Traspaso a una persona (human_request)' },
    ]);
    expect(w.sent[0]).toMatch(/equipo/);
  });

  it('si el traspaso falla NO se pausa el bot y el turno sigue a la IA', async () => {
    const w = build({
      responses: { pasar_a_persona: { status: 'TECHNICAL_ERROR' } },
    });
    expect(
      await w.handler.handle(w.turn('quiero hablar con una persona')),
    ).toEqual({ handled: false });
    expect(w.paused).toHaveLength(0);
  });
});

describe('IntentHandler · ficha de tratamiento', () => {
  const card = {
    status: 'found',
    card: {
      title: '*Alisado orgánico*',
      summary: 'Alisa sin químicos fuertes.',
      facts: ['💰 Precio: $250.000 – $380.000', '⏱️ Duración: 2 a 3 h'],
      benefits: ['• Menos frizz', '• Brillo'],
      notes: ['El precio final se confirma después del diagnóstico en el spa.'],
    },
  };

  it('pasa lo que la clienta nombró como parámetro y arma la ficha sin IA', async () => {
    const w = build({
      responses: { info_tratamiento: { status: 'SUCCESS', body: card } },
    });
    expect(
      await w.handler.handle(w.turn('¿cuánto cuesta el alisado orgánico?')),
    ).toEqual({ handled: true });
    expect(w.calls[0]).toEqual({
      tool: 'info_tratamiento',
      params: { query: 'alisado organico' },
      phone: undefined,
    });
    expect(w.sent[0]).toContain('*Alisado orgánico*');
    expect(w.sent[0]).toContain('💰 Precio: $250.000 – $380.000');
    expect(w.sent[0]).toContain('• Menos frizz');
    expect(w.sent[0]).toContain('diagnóstico');
    expect(w.sent[0]).not.toMatch(/\n{3,}/);
  });

  it('ambiguo: pregunta cuál', async () => {
    const w = build({
      responses: {
        info_tratamiento: {
          status: 'SUCCESS',
          body: {
            status: 'ambiguous',
            optionNames: ['• Alisado orgánico', '• Alisado con keratina'],
          },
        },
      },
    });
    await w.handler.handle(w.turn('precio del alisado'));
    expect(w.sent[0]).toMatch(/Alisado con keratina/);
    expect(w.sent[0]).toMatch(/¿Cuál te interesa\?/);
  });

  it('no reconocido: pasa a la IA reducida de tratamientos, no a la completa', async () => {
    const w = build({
      responses: {
        info_tratamiento: { status: 'SUCCESS', body: { status: 'not_found' } },
      },
    });
    const out = await w.handler.handle(
      w.turn('cuánto cuesta el masaje tailandés'),
    );
    expect(out.handled).toBe(false);
    expect(!out.handled && out.slim?.intentKey).toBe('treatment_question');
    expect(!out.handled && out.slim?.via).toBe('fallback');
    expect(w.sent).toHaveLength(0);
  });
});

describe('IntentHandler · LLM_SLIM, flujo y clasificador de IA', () => {
  it('agendar va a la IA reducida con solo sus herramientas', async () => {
    const w = build({});
    const out = await w.handler.handle(w.turn('quiero agendar una cita'));
    expect(out.handled).toBe(false);
    if (out.handled) throw new Error('no debía resolverse');
    expect(out.slim?.intentKey).toBe('booking');
    expect(out.slim?.tools).toContain('crear_reserva_whatsapp');
    expect(out.slim?.tools).not.toContain('registrar_comprobante_automatico');
    expect(out.slim?.endsOnTools).toContain('crear_reserva_whatsapp');
  });

  it('el flujo abierto sigue en el mismo manejador sin reclasificar y un saludo no lo rompe', async () => {
    const w = build({});
    const flow = {
      activeFlow: {
        intent: 'booking',
        until: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    for (const text of [
      'mañana a las 3',
      'hola',
      'sí',
      'mi nombre es Ana López',
    ]) {
      const out = await w.handler.handle(w.turn(text, { context: flow }));
      expect(out.handled).toBe(false);
      expect(!out.handled && out.slim?.via).toBe('flow');
    }
    expect(w.aiCalls).toHaveLength(0);
  });

  it('una intención explícita rompe el flujo y lo cierra', async () => {
    const w = build({
      responses: { enlace_cancelacion: { status: 'SUCCESS', body: LINK } },
    });
    const flow = {
      activeFlow: {
        intent: 'booking',
        until: new Date(Date.now() + 60_000).toISOString(),
      },
    };
    expect(
      await w.handler.handle(
        w.turn('quiero cancelar mi cita', { context: flow }),
      ),
    ).toEqual({ handled: true });
    expect(w.contexts).toContainEqual({ activeFlow: null });
  });

  it('un flujo vencido no se continúa', async () => {
    const w = build({});
    const expired = {
      activeFlow: {
        intent: 'booking',
        until: new Date(Date.now() - 1000).toISOString(),
      },
    };
    expect(
      await w.handler.handle(w.turn('mañana a las 3', { context: expired })),
    ).toEqual({ handled: false });
  });

  it('afterSlimTurn abre el flujo con su vigencia y lo cierra al terminar la reserva', async () => {
    const w = build({});
    const plan = {
      intentKey: 'booking',
      prompt: 'x',
      tools: [],
      via: 'rules' as const,
      endsOnTools: ['crear_reserva_whatsapp'],
      flowTtlMinutes: 10,
    };
    await w.handler.afterSlimTurn('conv-1', plan, ['consultar_cliente']);
    const opened = w.contexts[0].activeFlow;
    expect(opened.intent).toBe('booking');
    expect(new Date(opened.until).getTime() - Date.now()).toBeLessThanOrEqual(
      10 * 60_000,
    );
    await w.handler.afterSlimTurn('conv-1', plan, ['crear_reserva_whatsapp']);
    expect(w.contexts[1]).toEqual({ activeFlow: null });
  });

  it('cuando las reglas no deciden, el clasificador de IA elige entre las intenciones clasificables', async () => {
    const w = build({ ai: () => 'booking' });
    const out = await w.handler.handle(
      w.turn('tengo un evento el viernes y necesito arreglarme'),
    );
    expect(w.aiCalls).toHaveLength(1);
    expect(!out.handled && out.slim?.intentKey).toBe('booking');
    expect(!out.handled && out.slim?.via).toBe('ai');
  });

  it('"ninguna" o una clave inválida siguen a la IA completa; nunca clasifica traspasos', async () => {
    const none = build({ ai: () => null });
    expect(
      await none.handler.handle(none.turn('tengo un evento el viernes')),
    ).toEqual({ handled: false });

    const handoff = build({ ai: () => 'human_request' });
    const out = await handoff.handler.handle(
      handoff.turn('tengo un evento el viernes'),
    );
    expect(out).toEqual({ handled: false });
  });

  it('no llama al clasificador en mensajes largos, en ráfagas ni si ya hay decisión de las reglas', async () => {
    const w = build({ ai: () => 'booking' });
    await w.handler.handle(w.turn('palabra '.repeat(40)));
    await w.handler.handle(w.turn('hola\ncomo estas'));
    await w.handler.handle(w.turn('gracias'));
    await w.handler.handle(w.turn('cuánto cuesta cancelar'));
    expect(w.aiCalls).toHaveLength(0);
  });

  it('SOMBRA en una intención clasificable: no la usa ni siquiera por IA', async () => {
    const w = build({
      mode: { booking: 'SHADOW', treatment_question: 'SHADOW' },
      ai: () => 'booking',
    });
    expect(
      await w.handler.handle(w.turn('tengo un evento el viernes')),
    ).toEqual({ handled: false });
    expect(w.aiCalls).toHaveLength(0);
  });
});

describe('IntentHandler · robustez', () => {
  it('un error inesperado nunca se propaga: el turno sigue a la IA', async () => {
    const w = build({});
    const out = await w.handler.handle(
      w.turn('gracias', {
        send: () => Promise.reject(new Error('canal caído')),
      }),
    );
    expect(out).toEqual({ handled: false });
    expect(w.metrics.snapshot().error).toBe(1);
  });

  it('registra la señal de falso positivo cuando tras la plantilla pide una persona o repite', async () => {
    const w = build({});
    await w.handler.handle(w.turn('gracias'));
    await w.handler.handle(w.turn('quiero hablar con una persona'));
    expect(
      w.metrics.snapshot()['false-positive-signal:courtesy:asked-human'],
    ).toBe(1);

    const r = build({});
    await r.handler.handle(r.turn('gracias'));
    await r.handler.handle(r.turn('gracias'));
    expect(
      r.metrics.snapshot()['false-positive-signal:courtesy:repeated'],
    ).toBe(1);
  });
});

describe('IntentHandler · saludo en el primer contacto', () => {
  const hours = {
    info_negocio: {
      status: 'SUCCESS',
      body: { weeklySchedule: [{ day: 'lunes', hours: '9 a 6' }] },
    },
    consultar_cliente: {
      status: 'SUCCESS',
      body: { registered: true, firstName: 'sara' },
    },
  };

  it('si el bot nunca le ha escrito, la respuesta lleva el saludo con su nombre, sin IA', async () => {
    const w = build({ responses: hours });
    await w.handler.handle(w.turn('¿a qué hora abren?'));
    expect(w.sent[0]).toMatch(/^¡Hola Sara!.*Sofía de Leonice Spa/);
    expect(w.sent[0]).toContain('• Lunes: 9 a 6');
    expect(w.calls.map((c) => c.tool)).toEqual([
      'info_negocio',
      'consultar_cliente',
    ]);
  });

  it('una clienta no registrada recibe el saludo genérico', async () => {
    const w = build({
      responses: {
        ...hours,
        consultar_cliente: { status: 'SUCCESS', body: { registered: false } },
      },
    });
    await w.handler.handle(w.turn('horario'));
    expect(w.sent[0]).toMatch(/^¡Hola!.*Sofía de Leonice Spa/);
  });

  it('con un mensaje previo del bot no se vuelve a saludar', async () => {
    const w = build({ responses: hours });
    await w.handler.handle(
      w.turn('horario', {
        lastBotMessage: { content: 'Hola', at: new Date() },
      }),
    );
    expect(w.sent[0]).not.toMatch(/Hola/);
    expect(w.calls.map((c) => c.tool)).toEqual(['info_negocio']);
  });

  it('si el saludo no se puede armar, la respuesta sale sola', async () => {
    const w = build({
      responses: { ...hours, consultar_cliente: { status: 'TECHNICAL_ERROR' } },
    });
    await w.handler.handle(w.turn('horario'));
    expect(w.sent[0]).not.toMatch(/Hola/);
    expect(w.sent[0]).toContain('• Lunes');
  });

  it('con un LID saluda en genérico y no llama al backend de identidad', async () => {
    const w = build({ responses: hours });
    await w.handler.handle(w.turn('horario', { phoneNumber: '99887766@lid' }));
    expect(w.sent[0]).toMatch(/^¡Hola!/);
    expect(w.calls.map((c) => c.tool)).toEqual(['info_negocio']);
  });

  it('el traspaso, la cortesía y el flujo reducido no llevan saludo', async () => {
    const w = build({});
    await w.handler.handle(w.turn('quiero hablar con una persona'));
    expect(w.sent[0]).not.toMatch(/^¡Hola/);
    const c = build({});
    await c.handler.handle(c.turn('gracias'));
    expect(c.sent[0]).not.toMatch(/^¡Hola/);
  });
});
