import { HardRulesService } from 'src/bot/intent/HardRules.service';
import { IntentMetricsService } from 'src/bot/intent/intent-metrics.service';
import { IntentTurn } from 'src/bot/intent/intent-turn';
import { IntentModeValue } from 'src/bot/intent/intent-types';
import { intentSet, spaRecords } from './fixture';

function build(
  mode: IntentModeValue | Record<string, IntentModeValue> = 'ACTIVE',
) {
  const sent: string[] = [];
  const contexts: any[] = [];
  const paused: Array<{ minutes: number; reason: string }> = [];
  const optOuts: Array<{ address: string; optedOut: boolean }> = [];
  const notified: string[] = [];

  const metrics = new IntentMetricsService();
  (metrics as unknown as { logger: object }).logger = { log: jest.fn() };

  const service = new HardRulesService(
    { forBot: () => Promise.resolve(intentSet(spaRecords(mode))) } as never,
    {
      setOptOut: (_c: string, address: string, optedOut: boolean) => {
        optOuts.push({ address, optedOut });
        return Promise.resolve();
      },
    } as never,
    {
      updateContext: (_id: string, patch: any) => {
        contexts.push(patch.contextPatch);
        return Promise.resolve();
      },
      pauseBot: (_id: string, minutes: number, reason: string) => {
        paused.push({ minutes, reason });
        return Promise.resolve(new Date());
      },
    } as never,
    {
      notifyContacts: (_t: string, _b: string, _s: string, message: string) => {
        notified.push(message);
        return Promise.resolve(true);
      },
    } as never,
    metrics,
  );
  (service as unknown as { logger: object }).logger = {
    log: jest.fn(),
    error: jest.fn(),
  };

  const turn = (
    text: string,
    context: Record<string, unknown> = {},
  ): IntentTurn => ({
    tenantId: 't',
    botConfigId: 'bot',
    conversationId: 'conv-1',
    connectionId: 'conn',
    phoneNumber: '573001112233',
    text,
    hasImage: false,
    turnId: 'turn',
    context,
    lastBotMessage: null,
    loadTools: () => Promise.resolve([]),
    send: (reply) => {
      sent.push(reply);
      return Promise.resolve();
    },
  });
  return { service, turn, sent, contexts, paused, optOuts, notified, metrics };
}

describe('HardRulesService', () => {
  it('opt-out activo: confirma con el texto del spa, marca la conversación y el contacto', async () => {
    const w = build();
    expect(await w.service.apply(w.turn('no quiero más mensajes'))).toBe(true);
    expect(w.sent[0]).toMatch(/no te volveremos a escribir/);
    expect(w.contexts[0].optedOutAt).toEqual(expect.any(String));
    expect(w.optOuts).toEqual([{ address: '573001112233', optedOut: true }]);
  });

  it('en sombra solo registra y no cambia nada', async () => {
    const w = build('SHADOW');
    expect(await w.service.apply(w.turn('STOP'))).toBe(false);
    expect(w.sent).toHaveLength(0);
    expect(w.optOuts).toHaveLength(0);
    expect(w.metrics.snapshot()['rule:opt_out:shadow']).toBe(1);
  });

  it('apagada no detecta', async () => {
    const w = build('OFF');
    expect(await w.service.apply(w.turn('STOP'))).toBe(false);
  });

  it('con opt-out vigente el chat queda en silencio, salvo que pida volver', async () => {
    const w = build();
    const optedOut = { optedOutAt: '2026-10-01T00:00:00.000Z' };
    expect(await w.service.apply(w.turn('hola quiero agendar', optedOut))).toBe(
      true,
    );
    expect(w.sent).toHaveLength(0);

    expect(await w.service.apply(w.turn('quiero volver', optedOut))).toBe(true);
    expect(w.sent[0]).toMatch(/de vuelta/);
    expect(w.contexts.at(-1)).toEqual({ optedOutAt: null });
    expect(w.optOuts.at(-1)).toEqual({
      address: '573001112233',
      optedOut: false,
    });
  });

  it('la reactivación funciona aunque la regla opt_in esté en sombra, pero no si está apagada', async () => {
    const shadow = build({ 'rule.opt_in': 'SHADOW' });
    await shadow.service.apply(
      shadow.turn('quiero volver', { optedOutAt: 'x' }),
    );
    expect(shadow.contexts.at(-1)).toEqual({ optedOutAt: null });

    const off = build({ 'rule.opt_in': 'OFF' });
    expect(
      await off.service.apply(off.turn('quiero volver', { optedOutAt: 'x' })),
    ).toBe(true);
    expect(off.sent).toHaveLength(0);
  });

  it('abuso: la primera vez aviso fijo y aviso al equipo; si insiste, silencio temporal', async () => {
    const w = build();
    expect(await w.service.apply(w.turn('son unos hp'))).toBe(true);
    expect(w.sent[0]).toMatch(/mala experiencia/);
    expect(w.notified[0]).toMatch(/ofensivo/);
    expect(w.paused).toHaveLength(0);

    const again = { abuseAt: new Date().toISOString() };
    expect(await w.service.apply(w.turn('idiotas', again))).toBe(true);
    expect(w.sent).toHaveLength(1);
    expect(w.paused).toEqual([{ minutes: 60, reason: 'Abuso reiterado' }]);
  });

  it('spam: silencio temporal, sin respuesta, y avisa una sola vez por hora', async () => {
    const w = build();
    const text = 'Gana dinero fácil con bitcoin https://x.test/ya';
    expect(await w.service.apply(w.turn(text))).toBe(true);
    expect(w.sent).toHaveLength(0);
    expect(w.paused[0].reason).toMatch(/Spam/);
    expect(w.notified).toHaveLength(1);

    await w.service.apply(
      w.turn(text, { spamNotifiedAt: new Date().toISOString() }),
    );
    expect(w.notified).toHaveLength(1);
  });

  it('un mensaje normal no activa nada', async () => {
    const w = build();
    expect(await w.service.apply(w.turn('quiero cancelar mi cita'))).toBe(
      false,
    );
    expect(w.sent).toHaveLength(0);
  });

  it('sin texto configurado usa uno genérico y sin nombres del negocio', async () => {
    const records = spaRecords().filter((r) => !r.key.startsWith('rule.'));
    const set = intentSet(records);
    const modes = { ...set, modeOf: () => 'ACTIVE' as const };
    const w = build();
    (w.service as any).repository = { forBot: () => Promise.resolve(modes) };
    await w.service.apply(w.turn('STOP'));
    expect(w.sent[0]).toMatch(/volver/);
    expect(w.sent[0]).not.toMatch(/Leonice|spa/i);
  });
});
