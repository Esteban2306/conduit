import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DISABLED, envFileKeys, isolatedEnv } from 'test/bench/isolated-env';
import { recorder } from 'test/bench/recorder';
import { evaluateScenario, TurnResult } from 'test/bench/evaluate';
import { summarize } from 'test/bench/summary';
import type { Scenario } from 'test/bench/scenario-runner';

const PHONE = '573010000001';
const OTHER = '573010000002';
const ADMIN = '573000000999';

function reset(): void {
  recorder.llm.length = 0;
  recorder.tools.length = 0;
  recorder.sent.length = 0;
}

function turn(
  index: number,
  actor = 'A',
  phone = PHONE,
  startedAt = 1_000 + index * 10_000,
): TurnResult {
  return {
    index,
    actor,
    phone,
    input: [{ text: 'x' }],
    startedAt,
    endedAt: startedAt + 9_000,
    settled: true,
  };
}

function llm(turnIndex: number, stopReason = 'end_turn', scenarioId = 's') {
  recorder.llm.push({
    ctx: { scenarioId, turn: turnIndex, actor: 'A' },
    model: 'm',
    input: 4000,
    output: 100,
    thinking: 40,
    billable: 4100,
    cacheWrite: 0,
    cacheRead: 0,
    stopReason,
    tools: 13,
    toolUses: [],
    ms: 1000,
    usd: 0.00045,
  });
}

function reply(
  turnIndex: number,
  content: string,
  at: number,
  to = PHONE,
  actor = 'A',
) {
  recorder.sent.push({
    ctx: { scenarioId: 's', turn: turnIndex, actor },
    channel: 'WHATSAPP',
    to,
    content,
    connectionId: 'c',
    at,
  });
}

function scenario(
  expect: Record<string, unknown>,
  turns: Scenario['turns'] = [{ actor: 'A', messages: [{ text: 'hola' }] }],
): Scenario {
  return { id: 's', category: 'x', title: 't', turns, expect };
}

function run(
  sc: Scenario,
  turns: TurnResult[],
  extra: Partial<Parameters<typeof evaluateScenario>[0]> = {},
) {
  return evaluateScenario({
    scenario: sc,
    phones: new Map([['A', PHONE]]),
    prior: null,
    turns,
    finalState: {},
    inbound: [],
    adminPhone: ADMIN,
    durationMs: 60_000,
    ...extra,
  });
}

describe('isolated-env', () => {
  it('reemplaza cada clave del .env del repo y deja ganar a los valores del banco', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-env-'));
    fs.writeFileSync(
      path.join(dir, '.env'),
      'CONDUIT_BASE_URL=https://real.example\nSECRET_KEY = abc\n# COMENTARIO=1\nREDIS_URL=redis://localhost:6379\n',
    );
    expect(envFileKeys(dir)).toEqual([
      'CONDUIT_BASE_URL',
      'SECRET_KEY',
      'REDIS_URL',
    ]);
    const env = isolatedEnv(dir, { REDIS_URL: 'redis://127.0.0.1:56390/1' });
    expect(env.CONDUIT_BASE_URL).toBe(DISABLED);
    expect(env.SECRET_KEY).toBe(DISABLED);
    expect(env.REDIS_URL).toBe('redis://127.0.0.1:56390/1');
    expect(Object.keys(env)).not.toContain('npm_config_user_agent');
  });
});

describe('evaluateScenario', () => {
  beforeEach(reset);

  it('clasifica rutas: IA con modelo, ignorado sin respuesta, directo sin modelo', () => {
    llm(0);
    reply(0, 'Hola, ¿en qué te ayudo?', 5_000);
    reply(2, 'Recibimos tu mensaje', 25_000);
    const result = run(
      scenario({ route: 'IA' }, [
        { actor: 'A', messages: [{ text: 'hola' }] },
        {
          actor: 'A',
          messages: [{ text: 'gracias' }],
          expect: { route: 'ignorado' },
        },
        { actor: 'A', messages: [{ text: 'hola?' }] },
      ]),
      [turn(0), turn(1), turn(2)],
    );
    expect(result.turns.map((t) => t.route)).toEqual([
      'IA',
      'ignorado',
      'directo',
    ]);
    expect(result.pass).toBe(true);
  });

  it('un acuse se procesa si el bot preguntó y se ignora si no', () => {
    llm(0);
    reply(0, 'Quedamos en la calle 10. ¿Quieres agendar?', 5_000);
    llm(1);
    reply(1, 'Perfecto', 15_000);
    reply(2, 'Listo, te espero', 25_000);
    const turns: Scenario['turns'] = [
      { actor: 'A', messages: [{ text: 'dónde quedan' }] },
      { actor: 'A', messages: [{ text: 'sí' }], expect: { route: 'acuse' } },
      {
        actor: 'A',
        messages: [{ text: 'gracias' }],
        expect: { route: 'acuse' },
      },
    ];
    const result = run(scenario({}, turns), [turn(0), turn(1), turn(2)]);
    expect(result.failures).toEqual([
      'turno 3: ruta directo, se esperaba ignorado',
    ]);
  });

  it('cuenta como usada una herramienta que el modelo pidió aunque Conduit la rechace antes de llamar al backend', () => {
    recorder.llm.push({
      ctx: { scenarioId: 's', turn: 0, actor: 'A' },
      model: 'm',
      input: 10,
      output: 5,
      thinking: 0,
      cacheWrite: 0,
      cacheRead: 0,
      stopReason: 'tool_use',
      tools: 13,
      toolUses: ['registrar_comprobante_automatico'],
      ms: 1,
      usd: 0,
    });
    reply(0, 'ok', 5_000);
    const result = run(
      scenario({ toolsAll: ['registrar_comprobante_automatico'] }),
      [turn(0)],
    );
    expect(result.pass).toBe(true);
    expect(result.turns[0].requestedTools).toEqual([
      'registrar_comprobante_automatico',
    ]);
  });

  it('marca turnos cortados por max_tokens y respuestas vacías o invisibles', () => {
    llm(0, 'max_tokens');
    reply(0, '​‌', 5_000);
    const result = run(scenario({ notCutOrEmpty: true }), [turn(0)]);
    expect(result.turns[0].flags).toEqual(
      expect.arrayContaining(['cortado', 'vacío']),
    );
    expect(result.pass).toBe(false);
  });

  it('detecta la promesa de persona sin aviso al equipo y la acepta si hubo traspaso', () => {
    llm(0);
    reply(
      0,
      'Tuvimos un inconveniente al procesar tu solicitud. Una persona de nuestro equipo se pondrá en contacto contigo en breve.',
      5_000,
    );
    const failed = run(scenario({ noFalseHumanPromise: true }), [turn(0)]);
    expect(failed.flags).toEqual(
      expect.arrayContaining(['genérico-por-herramienta', 'promesa-falsa']),
    );
    expect(failed.pass).toBe(false);

    recorder.tools.push({
      ctx: { scenarioId: 's', turn: 0, actor: 'A' },
      name: 'pasar_a_persona',
      status: 'SUCCESS',
      httpStatus: 200,
      ms: 50,
      errorDetail: null,
    });
    const ok = run(scenario({ noFalseHumanPromise: true }), [turn(0)]);
    expect(ok.flags).not.toContain('promesa-falsa');
    expect(ok.pass).toBe(true);
  });

  it('no confunde ofrecer o mencionar a una persona con prometer un contacto', () => {
    llm(0);
    reply(
      0,
      'Te recomiendo verificarlo con una persona del equipo antes de reservar. ¿Quieres que los contacte?',
      5_000,
    );
    reply(
      0,
      'Tu hermana puede comunicarse directamente con nosotros desde su propio número.',
      6_000,
    );
    const result = run(scenario({ noFalseHumanPromise: true }), [turn(0)]);
    expect(result.flags).not.toContain('promesa-falsa');
    expect(result.pass).toBe(true);
  });

  it('evalúa herramientas obligatorias, prohibidas y el estado final en Leonice', () => {
    llm(0);
    recorder.tools.push({
      ctx: { scenarioId: 's', turn: 0, actor: 'A' },
      name: 'reservas_proximas',
      status: 'SUCCESS',
      httpStatus: 200,
      ms: 50,
      errorDetail: null,
    });
    reply(0, 'Tu cita es el sábado', 5_000);
    const result = run(
      scenario({
        toolsAll: ['reservas_proximas', 'cancelar_reserva_whatsapp'],
        toolsForbidden: ['reservas_proximas'],
        finalState: { reservationStatus: 'CANCELADA' },
      }),
      [turn(0)],
      { finalState: { A: { reservations: [{ status: 'CONFIRMADA' }] } } },
    );
    expect(result.failures).toEqual([
      'no usó cancelar_reserva_whatsapp',
      'usó la prohibida reservas_proximas',
      'estado final CONFIRMADA, se esperaba CANCELADA',
    ]);
  });

  it('detecta texto de otra clienta guardado en la conversación (mezcla de chats)', () => {
    const turns: Scenario['turns'] = [
      { actor: 'A', messages: [{ text: 'precio del spa coreano' }] },
      {
        actor: 'B',
        messages: [{ text: 'dónde queda' }],
        concurrentWithPrevious: true,
      },
    ];
    reply(1, 'Queda en el centro', 6_000, OTHER, 'B');
    const result = run(
      scenario({ noCrossTalk: true, everyActorAnswered: true }, turns),
      [turn(0), turn(1, 'B', OTHER, 1_100)],
      {
        phones: new Map([
          ['A', PHONE],
          ['B', OTHER],
        ]),
        inbound: [
          { phone: OTHER, content: 'precio del spa coreano\ndónde queda' },
        ],
      },
    );
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining('la conversación de B guardó texto ajeno'),
        'A no recibió respuesta',
      ]),
    );
  });

  it('un caso marcado como fallo conocido se reporta como reproducido cuando falla', () => {
    llm(0, 'max_tokens');
    reply(0, 'Te explico: el alisado sirve para', 5_000);
    const result = run(
      { ...scenario({ notCutOrEmpty: true }), knownFailure: 'A1' },
      [turn(0)],
    );
    expect(result.knownFailure).toBe('A1');
    expect(result.knownFailureReproduced).toBe(true);
  });
});

describe('summarize', () => {
  beforeEach(reset);

  it('calcula percentiles y separa aciertos regulares de fallos conocidos', () => {
    llm(0);
    reply(0, 'hola', 5_000);
    const ok = run(scenario({}), [turn(0)]);
    const known = {
      ...ok,
      id: 's2',
      knownFailure: 'C1',
      knownFailureReproduced: true,
      pass: false,
    };
    const summary = summarize(
      [ok, known],
      { spentUsd: 0.0009, budgetExceeded: false, llm: recorder.llm },
      1000,
      400_000,
    );
    expect(summary.passRegular).toBe('1/1');
    expect(summary.knownFailuresReproduced).toBe('1/1');
    expect(summary.routes.IA).toBe(2);
    expect(summary.perTurn.inputTokens.p50).toBe(4000);
    expect(summary.perConversation.conversationsPerDailyCap).toBe(97);
    expect(summary.perTurn.thinkingTokens.share).toBeCloseTo(0.4);
  });
});
