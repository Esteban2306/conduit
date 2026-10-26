import { HandoffService } from 'src/bot/handoff/Handoff.service';
import {
  DEFAULT_HANDOFF_FAILED_TEXT,
  DEFAULT_HANDOFF_TEXT,
} from 'src/bot/handoff/handoff-defaults';

const HANDOFF_TOOL = {
  definitionId: 'def-h',
  spec: { name: 'pasar_a_persona' },
  injectPhoneParamName: 'phone',
  pausesBotMinutes: 240,
  readOnly: false,
};

interface Options {
  tool?: object | null;
  backend?: { status: string; body?: unknown } | Error;
  contacts?: boolean | Error;
  variants?: Record<string, string[]>;
}

function build(options: Options = {}) {
  const paused: Array<{ minutes: number; reason: string }> = [];
  const contexts: Array<Record<string, unknown>> = [];
  const executed: unknown[] = [];
  const notified: string[] = [];

  const service = new HandoffService(
    {
      execute: jest.fn((req: unknown) => {
        executed.push(req);
        const r = options.backend ?? {
          status: 'SUCCESS',
          body: { teamNotified: true },
        };
        return r instanceof Error
          ? Promise.reject(r)
          : Promise.resolve({
              status: r.status,
              responseBody: r.body ?? null,
              httpStatus: 200,
              errorDetail: null,
              invocationId: null,
            });
      }),
    } as never,
    {
      notifyContacts: jest.fn(
        (_t: string, _b: string, _s: string, message: string) => {
          notified.push(message);
          const c = options.contacts ?? true;
          return c instanceof Error ? Promise.reject(c) : Promise.resolve(c);
        },
      ),
    } as never,
    {
      pauseBot: (_id: string, minutes: number, reason: string) => {
        paused.push({ minutes, reason });
        return Promise.resolve(new Date());
      },
      updateContext: (
        _id: string,
        patch: { contextPatch: Record<string, unknown> },
      ) => {
        contexts.push(patch.contextPatch);
        return Promise.resolve();
      },
    } as never,
    {
      forBot: () =>
        Promise.resolve({
          byKey: new Map(
            Object.entries(options.variants ?? {}).map(([key, list]) => [
              key,
              { variants: { default: list } },
            ]),
          ),
          agent: 'Sofía',
          business: 'Leonice Spa',
        }),
    } as never,
  );
  (service as unknown as { logger: object }).logger = {
    error: jest.fn(),
    warn: jest.fn(),
  };

  const request = (extra: Record<string, unknown> = {}) => ({
    tenantId: 't',
    botConfigId: 'bot',
    conversationId: 'conv-1',
    connectionId: 'conn',
    phoneNumber: '573001112233',
    reason: 'Fallo técnico en crear_reserva',
    context: {},
    loadTools: () =>
      Promise.resolve(
        options.tool === null ? [] : [options.tool ?? HANDOFF_TOOL],
      ) as never,
    ...extra,
  });
  return { service, request, paused, contexts, executed, notified };
}

describe('HandoffService.perform', () => {
  it('el backend confirma el aviso: pausa el bot con los minutos de la herramienta y promete una persona', async () => {
    const w = build();
    const out = await w.service.perform(w.request());
    expect(out).toMatchObject({ notified: true, alreadyHandedOff: false });
    expect(out.text).toBe(DEFAULT_HANDOFF_TEXT);
    expect(w.paused).toEqual([
      { minutes: 240, reason: 'Traspaso: Fallo técnico en crear_reserva' },
    ]);
    expect(w.contexts[0]).toMatchObject({
      handoffReason: 'Fallo técnico en crear_reserva',
    });
    expect(w.notified).toHaveLength(0);
    expect(w.executed[0]).toMatchObject({
      injectedPhone: '573001112233',
      params: { reason: 'Fallo técnico en crear_reserva' },
    });
  });

  it('si el backend responde que nadie recibirá el aviso, usa los contactos de escalamiento', async () => {
    const w = build({
      backend: { status: 'SUCCESS', body: { teamNotified: false } },
    });
    const out = await w.service.perform(w.request());
    expect(out.notified).toBe(true);
    expect(w.notified[0]).toMatch(/573001112233/);
    expect(w.paused).toHaveLength(1);
  });

  it.each([
    ['la herramienta falla', { status: 'TECHNICAL_ERROR' }],
    ['la herramienta lanza', new Error('red')],
  ])('si %s, el respaldo nativo avisa', async (_name, backend) => {
    const w = build({ backend: backend as never });
    expect((await w.service.perform(w.request())).notified).toBe(true);
    expect(w.notified).toHaveLength(1);
  });

  it('sin herramienta de traspaso usa solo los contactos', async () => {
    const w = build({ tool: null });
    const out = await w.service.perform(w.request());
    expect(out.notified).toBe(true);
    expect(w.executed).toHaveLength(0);
    expect(w.paused[0].minutes).toBe(240);
  });

  it('si nadie pudo ser avisado NO pausa el bot y NO promete una persona', async () => {
    const w = build({
      backend: { status: 'SUCCESS', body: { teamNotified: false } },
      contacts: false,
    });
    const out = await w.service.perform(w.request());
    expect(out.notified).toBe(false);
    expect(out.text).toBe(DEFAULT_HANDOFF_FAILED_TEXT);
    expect(out.text).not.toMatch(/persona|equipo/i);
    expect(w.paused).toHaveLength(0);
    expect(w.contexts).toHaveLength(0);
  });

  it('con un LID no llama al backend (no hay teléfono) pero avisa por los contactos', async () => {
    const w = build();
    const out = await w.service.perform(
      w.request({ phoneNumber: '998877@lid' }),
    );
    expect(out.notified).toBe(true);
    expect(w.executed).toHaveLength(0);
    expect(w.notified).toHaveLength(1);
  });

  it('es idempotente: con un traspaso vigente no vuelve a avisar ni a pausar', async () => {
    const w = build();
    const context = {
      handoffAt: new Date().toISOString(),
      botPausedUntil: new Date(Date.now() + 60_000).toISOString(),
    };
    const out = await w.service.perform(w.request({ context }));
    expect(out).toMatchObject({ alreadyHandedOff: true, notified: true });
    expect(w.executed).toHaveLength(0);
    expect(w.notified).toHaveLength(0);
    expect(w.paused).toHaveLength(0);
  });

  it('pasada la pausa un traspaso nuevo sí avisa', async () => {
    const w = build();
    const context = {
      handoffAt: new Date(Date.now() - 600_000).toISOString(),
      botPausedUntil: new Date(Date.now() - 60_000).toISOString(),
    };
    expect(
      (await w.service.perform(w.request({ context }))).alreadyHandedOff,
    ).toBe(false);
    expect(w.executed).toHaveLength(1);
  });

  it('dos traspasos simultáneos del mismo chat avisan una sola vez', async () => {
    const w = build();
    const [a, b] = await Promise.all([
      w.service.perform(w.request()),
      w.service.perform(w.request()),
    ]);
    expect([a.alreadyHandedOff, b.alreadyHandedOff].sort()).toEqual([
      false,
      true,
    ]);
    expect(w.executed).toHaveLength(1);
  });

  it('usa los textos del negocio (regla rule.handoff) si existen', async () => {
    const w = build({
      variants: {
        'rule.handoff': ['{{agente}} avisó al equipo de {{negocio}}'],
      },
    });
    expect((await w.service.perform(w.request())).text).toBe(
      'Sofía avisó al equipo de Leonice Spa',
    );
  });
});

describe('HandoffService.afterModelHandoff', () => {
  const request = {
    tenantId: 't',
    botConfigId: 'bot',
    conversationId: 'conv-1',
    connectionId: 'conn',
    phoneNumber: '573001112233',
    reason: 'Traspaso solicitado (pasar_a_persona)',
    context: {},
  };

  it('el backend confirmó el aviso: pausa', async () => {
    const w = build();
    expect(
      await w.service.afterModelHandoff(request, { teamNotified: true }, 240),
    ).toBe(true);
    expect(w.paused).toHaveLength(1);
  });

  it('el backend dijo que nadie recibirá el aviso: respaldo nativo; si tampoco, no pausa', async () => {
    const ok = build({ contacts: true });
    expect(
      await ok.service.afterModelHandoff(request, { teamNotified: false }, 240),
    ).toBe(true);
    const bad = build({ contacts: false });
    expect(
      await bad.service.afterModelHandoff(
        request,
        { teamNotified: false },
        240,
      ),
    ).toBe(false);
    expect(bad.paused).toHaveLength(0);
  });

  it('una respuesta antigua sin teamNotified se toma como confirmada', async () => {
    const w = build();
    expect(
      await w.service.afterModelHandoff(request, { handedOff: true }, 240),
    ).toBe(true);
  });
});
