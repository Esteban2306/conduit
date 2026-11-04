import {
  RecordedOutcome,
  classifyOutcome,
  nextStreaks,
  unresolvedFailures,
} from 'src/bot/tools/tool-outcome';

describe('classifyOutcome', () => {
  it('éxito', () => {
    expect(classifyOutcome('SUCCESS', 200, {}).kind).toBe('SUCCESS');
  });

  it('un 409 o 404 del negocio es ESPERADO y conserva el código, el mensaje, el siguiente paso y las alternativas', () => {
    const out = classifyOutcome('BUSINESS_ERROR', 409, {
      statusCode: 409,
      code: 'PLACEMENT_NO_SLOT_THAT_DAY',
      message: 'No hay horario disponible ese día.',
      nextStep: 'OFFER_OTHER_SLOT',
      details: { alternatives: [{ date: '2026-11-03', times: ['9:00'] }] },
    });
    expect(out).toMatchObject({
      kind: 'EXPECTED',
      code: 'PLACEMENT_NO_SLOT_THAT_DAY',
      nextStep: 'OFFER_OTHER_SLOT',
      alternatives: [{ date: '2026-11-03', times: ['9:00'] }],
    });
    expect(classifyOutcome('BUSINESS_ERROR', 404, null).kind).toBe('EXPECTED');
  });

  it.each([
    ['TECHNICAL_ERROR', null],
    ['TECHNICAL_ERROR', 500],
    ['TECHNICAL_ERROR', 503],
    ['BUSINESS_ERROR', 408],
    ['BUSINESS_ERROR', 429],
  ])('%s con http %s es TÉCNICO', (status, http) => {
    expect(classifyOutcome(status, http, null).kind).toBe('TECHNICAL');
  });

  it.each([401, 403])('un %s es de PERMISO o identidad', (http) => {
    expect(classifyOutcome('BUSINESS_ERROR', http, {}).kind).toBe('PERMISSION');
  });

  it('un cuerpo que no es un objeto no rompe', () => {
    expect(classifyOutcome('BUSINESS_ERROR', 400, 'texto').kind).toBe(
      'EXPECTED',
    );
    expect(classifyOutcome('BUSINESS_ERROR', 400, [1, 2]).kind).toBe(
      'EXPECTED',
    );
  });
});

describe('nextStreaks', () => {
  const expected = (code: string) =>
    classifyOutcome('BUSINESS_ERROR', 409, { code });

  it('cuenta el mismo código seguido y lo reinicia con otro código o con un éxito', () => {
    let state = {};
    let count = 0;
    for (let i = 1; i <= 3; i++) {
      ({ streaks: state, count } = nextStreaks(state, 'crear', expected('A')));
      expect(count).toBe(i);
    }
    ({ streaks: state, count } = nextStreaks(state, 'crear', expected('B')));
    expect(count).toBe(1);
    ({ streaks: state, count } = nextStreaks(
      state,
      'crear',
      classifyOutcome('SUCCESS', 200, {}),
    ));
    expect(count).toBe(0);
    expect(state).toEqual({});
  });

  it('cada herramienta lleva su propia racha y lo técnico no cuenta', () => {
    let { streaks } = nextStreaks({}, 'crear', expected('A'));
    ({ streaks } = nextStreaks(streaks, 'reagendar', expected('A')));
    expect(streaks).toEqual({
      crear: { code: 'A', count: 1 },
      reagendar: { code: 'A', count: 1 },
    });
    const tech = classifyOutcome('TECHNICAL_ERROR', 500, null);
    expect(nextStreaks(streaks, 'crear', tech).count).toBe(0);
  });
});

describe('unresolvedFailures', () => {
  const ok = classifyOutcome('SUCCESS', 200, {});
  const bad = classifyOutcome('BUSINESS_ERROR', 409, { code: 'X' });
  const call = (tool: string, outcome: typeof ok, readOnly = false) =>
    ({ tool, outcome, readOnly }) as RecordedOutcome;

  it('sin llamadas o con éxitos no hay fallos', () => {
    expect(unresolvedFailures([])).toEqual([]);
    expect(unresolvedFailures([call('a', ok)])).toEqual([]);
  });

  it('un fallo de escritura que ninguna llamada posterior corrige cuenta', () => {
    expect(
      unresolvedFailures([call('lista', ok, true), call('crear', bad)]),
    ).toHaveLength(1);
  });

  it('un fallo seguido de un éxito de la misma herramienta queda corregido, y un éxito seguido de fallo no', () => {
    expect(unresolvedFailures([call('c', bad), call('c', ok)])).toEqual([]);
    expect(unresolvedFailures([call('c', ok), call('c', bad)])).toHaveLength(1);
  });

  it('una lectura fallida queda resuelta por otra lectura posterior exitosa, no así una escritura', () => {
    expect(
      unresolvedFailures([call('disp', bad, true), call('otra', ok, true)]),
    ).toEqual([]);
    expect(
      unresolvedFailures([call('crear', bad), call('lista', ok, true)]),
    ).toHaveLength(1);
  });

  it('corregir una herramienta no oculta el fallo de otra', () => {
    const result = unresolvedFailures([
      call('disp', bad, true),
      call('disp', ok, true),
      call('crear', bad),
    ]);
    expect(result.map((r) => r.tool)).toEqual(['crear']);
  });
});
