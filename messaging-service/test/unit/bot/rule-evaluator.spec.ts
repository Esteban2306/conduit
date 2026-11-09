import {
  EvaluationContext,
  evaluateRules,
} from 'src/bot/specialists/rule-evaluator';
import { decideVerdict, summarize } from 'src/bot/specialists/verdict-policy';
import { MAX_HUMAN_SUMMARY } from 'src/bot/specialists/contracts';
import {
  containsTokens,
  fuzzySimilarity,
  normalizeText,
} from 'src/bot/specialists/text-match';

type Fields = Record<string, unknown>;
type RuleInput = Record<string, unknown>;

const NOW = new Date('2026-11-08T15:00:00Z');

const context = (
  grounding: EvaluationContext['grounding'] = {},
  overrides: Partial<EvaluationContext> = {},
): EvaluationContext => ({
  grounding,
  now: NOW,
  timeZone: 'America/Bogota',
  ...overrides,
});

const fields = (extra: Fields = {}) => ({
  amount: 150000,
  currency: 'COP',
  date: '2026-11-08',
  reference: 'TRX-48210377',
  recipient: 'Spa Demo S.A.S.',
  legibility: 'CLEAR',
  ...extra,
});

const rule = (extra: RuleInput) => ({
  field: 'amount',
  op: 'gte',
  ref: { literal: 100000 },
  onFail: 'INVALID',
  ...extra,
});

const run = (
  rules: RuleInput[],
  extra: Fields = {},
  ctx: EvaluationContext = context(),
) => evaluateRules(fields(extra) as never, { version: 1, rules } as never, ctx);

describe('evaluador de reglas', () => {
  describe('sin reglas', () => {
    it('es VALID con NO_RULES_CONFIGURED', () => {
      expect(run([])).toMatchObject({
        verdict: 'VALID',
        reasonCodes: ['NO_RULES_CONFIGURED'],
        results: [],
      });
    });
  });

  describe('gte', () => {
    it('pasa cuando el monto supera el mínimo y en el borde exacto', () => {
      expect(run([rule({})]).verdict).toBe('VALID');
      expect(run([rule({ ref: { literal: 150000 } })]).verdict).toBe('VALID');
    });

    it('falla con el onFail de la regla', () => {
      expect(run([rule({ ref: { literal: 150001 } })])).toMatchObject({
        verdict: 'INVALID',
        reasonCodes: ['AMOUNT_GTE_FAILED'],
      });
      expect(
        run([rule({ ref: { literal: 150001 }, onFail: 'NEEDS_REVIEW' })])
          .verdict,
      ).toBe('NEEDS_REVIEW');
    });

    it('compara contra un valor de contexto numérico o numérico en texto', () => {
      expect(
        run([rule({ ref: 'grounding.minimo' })], {}, context({ minimo: 30000 }))
          .verdict,
      ).toBe('VALID');
      expect(
        run(
          [rule({ ref: 'grounding.minimo' })],
          {},
          context({ minimo: '200000' }),
        ).verdict,
      ).toBe('INVALID');
    });
  });

  describe('lte', () => {
    it('pasa bajo el máximo y en el borde, falla por encima', () => {
      const lte = (value: number) =>
        run([rule({ op: 'lte', ref: { literal: value } })]).verdict;
      expect(lte(200000)).toBe('VALID');
      expect(lte(150000)).toBe('VALID');
      expect(lte(149999)).toBe('INVALID');
    });
  });

  describe('eq', () => {
    const eq = (field: string, literal: string | number, extra: Fields = {}) =>
      run([rule({ field, op: 'eq', ref: { literal } })], extra).verdict;

    it('el monto tolera medio centavo y nada más', () => {
      expect(eq('amount', 150000, { amount: 150000.004 })).toBe('VALID');
      expect(eq('amount', 150000, { amount: 150000.01 })).toBe('INVALID');
    });

    it('los textos ignoran mayúsculas, tildes y puntuación', () => {
      expect(eq('currency', 'cop')).toBe('VALID');
      expect(eq('recipient', 'SPA DEMO SAS')).toBe('VALID');
      expect(eq('recipient', 'Spá Demo S.A.S')).toBe('VALID');
      expect(eq('recipient', 'Otro Negocio')).toBe('INVALID');
    });

    it('la fecha se compara como texto exacto', () => {
      expect(eq('date', '2026-11-08')).toBe('VALID');
      expect(eq('date', '2026-11-07')).toBe('INVALID');
    });

    it('la legibilidad se puede exigir', () => {
      expect(eq('legibility', 'CLEAR')).toBe('VALID');
    });

    it('un valor de contexto no numérico para un monto pide revisión', () => {
      expect(
        run(
          [rule({ op: 'eq', ref: 'grounding.x' })],
          {},
          context({ x: 'abc' }),
        ),
      ).toMatchObject({
        verdict: 'NEEDS_REVIEW',
        reasonCodes: ['RULE_OPERAND_INVALID'],
      });
    });
  });

  describe('within_days', () => {
    const within = (
      days: number | string,
      date: string,
      ctx: EvaluationContext = context(),
    ) =>
      run(
        [
          rule({
            field: 'date',
            op: 'within_days',
            ref: typeof days === 'number' ? { literal: days } : days,
          }),
        ],
        { date },
        ctx,
      );

    it('hoy y dentro de la ventana pasan, más viejo falla', () => {
      expect(within(3, '2026-11-08').verdict).toBe('VALID');
      expect(within(3, '2026-11-05').verdict).toBe('VALID');
      expect(within(3, '2026-11-04')).toMatchObject({
        verdict: 'INVALID',
        reasonCodes: ['DATE_WITHIN_DAYS_FAILED'],
      });
    });

    it('con ventana 0 solo vale hoy', () => {
      expect(within(0, '2026-11-08').verdict).toBe('VALID');
      expect(within(0, '2026-11-07').verdict).toBe('INVALID');
    });

    it('una fecha futura tolera un día y no más', () => {
      expect(within(3, '2026-11-09').verdict).toBe('VALID');
      expect(within(3, '2026-11-10').verdict).toBe('INVALID');
    });

    it('usa el día de la zona horaria configurada, no el de UTC', () => {
      const lateNight = new Date('2026-11-09T03:00:00Z');
      expect(
        within(0, '2026-11-08', context({}, { now: lateNight })).verdict,
      ).toBe('VALID');
      expect(
        within(
          0,
          '2026-11-08',
          context({}, { now: lateNight, timeZone: 'UTC' }),
        ).verdict,
      ).toBe('INVALID');
    });

    it('la ventana puede venir del contexto', () => {
      expect(
        within('grounding.dias', '2026-11-01', context({ dias: 10 })).verdict,
      ).toBe('VALID');
      expect(
        within('grounding.dias', '2026-11-01', context({ dias: 2 })).verdict,
      ).toBe('INVALID');
    });

    it('una ventana de contexto inválida pide revisión', () => {
      expect(
        within('grounding.dias', '2026-11-08', context({ dias: 'x' })),
      ).toMatchObject({
        verdict: 'NEEDS_REVIEW',
        reasonCodes: ['RULE_OPERAND_INVALID'],
      });
      expect(
        within('grounding.dias', '2026-11-08', context({ dias: -1 })).verdict,
      ).toBe('NEEDS_REVIEW');
    });
  });

  describe('contains', () => {
    const contains = (literal: string, extra: Fields = {}) =>
      run(
        [rule({ field: 'recipient', op: 'contains', ref: { literal } })],
        extra,
      ).verdict;

    it('encuentra palabras completas sin importar tildes ni mayúsculas', () => {
      expect(contains('spa demo')).toBe('VALID');
      expect(contains('DEMO')).toBe('VALID');
      expect(contains('spá', { recipient: 'SPA Demo' })).toBe('VALID');
    });

    it('no acepta fragmentos de una palabra', () => {
      expect(contains('spa', { recipient: 'Spanish School' })).toBe('INVALID');
      expect(contains('dem')).toBe('INVALID');
    });

    it('un valor de contexto vacío no coincide con nada', () => {
      expect(
        run(
          [
            rule({
              field: 'recipient',
              op: 'contains',
              ref: 'grounding.titular',
            }),
          ],
          {},
          context({ titular: '   ' }),
        ).verdict,
      ).toBe('INVALID');
    });
  });

  describe('fuzzy', () => {
    const fuzzy = (literal: string, extra: Fields = {}, threshold?: number) =>
      run(
        [
          rule({
            field: 'recipient',
            op: 'fuzzy',
            ref: { literal },
            ...(threshold ? { threshold } : {}),
          }),
        ],
        extra,
      ).verdict;

    it('acepta el nombre con sufijos legales, puntuación y mayúsculas distintas', () => {
      expect(fuzzy('Spa Demo')).toBe('VALID');
      expect(fuzzy('SPA DEMO SAS', { recipient: 'Spa Demo S.A.S.' })).toBe(
        'VALID',
      );
    });

    it('ignora la forma legal al comparar nombres', () => {
      expect(fuzzy('Spa Demo Ltda')).toBe('VALID');
      expect(fuzzy('Spa Demo S.A.')).toBe('VALID');
    });

    it('si solo quedaba la forma legal, la compara tal cual', () => {
      expect(fuzzySimilarity('SAS', 'SAS')).toBe(1);
      expect(fuzzySimilarity('SAS', 'LTDA')).toBeLessThan(0.5);
    });

    it('acepta el orden invertido de nombre y apellido', () => {
      expect(fuzzy('Maria Perez', { recipient: 'Perez Maria' })).toBe('VALID');
    });

    it('tolera un error de tipeo', () => {
      expect(fuzzy('Spa Demo', { recipient: 'Spa Dmo' })).toBe('VALID');
    });

    it('rechaza otro titular', () => {
      expect(fuzzy('Spa Demo', { recipient: 'Juan Gomez' })).toBe('INVALID');
    });

    it('el umbral propio de la regla endurece o relaja', () => {
      expect(fuzzy('Spa Demo', { recipient: 'Spa Dmo' }, 0.95)).toBe('INVALID');
      expect(fuzzy('Spa Demo', { recipient: 'Spa Demoz Plus' }, 0.5)).toBe(
        'VALID',
      );
    });
  });

  describe('datos faltantes', () => {
    it('un campo no leído pide revisión aunque la regla diga INVALID', () => {
      expect(run([rule({})], { amount: null })).toMatchObject({
        verdict: 'NEEDS_REVIEW',
        reasonCodes: ['AMOUNT_MISSING'],
      });
      expect(run([rule({})], { amount: undefined }).verdict).toBe(
        'NEEDS_REVIEW',
      );
    });

    it('un valor de contexto ausente pide revisión y nunca da VALID', () => {
      for (const grounding of [{}, { minimo: null }, { minimo: true }]) {
        const result = run(
          [rule({ ref: 'grounding.minimo' })],
          {},
          context(grounding),
        );
        expect(result.verdict).toBe('NEEDS_REVIEW');
        expect(result.reasonCodes).toEqual(['GROUNDING_UNAVAILABLE']);
      }
    });
  });

  describe('agregación', () => {
    it('INVALID gana sobre NEEDS_REVIEW y VALID', () => {
      const result = run([
        rule({ ref: { literal: 1 } }),
        rule({ ref: { literal: 999999 }, onFail: 'NEEDS_REVIEW' }),
        rule({ field: 'amount', op: 'lte', ref: { literal: 1 } }),
      ]);
      expect(result.verdict).toBe('INVALID');
    });

    it('NEEDS_REVIEW gana sobre VALID', () => {
      expect(
        run([
          rule({}),
          rule({ ref: { literal: 999999 }, onFail: 'NEEDS_REVIEW' }),
        ]).verdict,
      ).toBe('NEEDS_REVIEW');
    });

    it('los motivos van de más grave a menos, sin repetirse', () => {
      const result = run(
        [
          rule({ ref: { literal: 999999 }, onFail: 'NEEDS_REVIEW' }),
          rule({ field: 'amount', op: 'lte', ref: { literal: 1 } }),
          rule({ ref: { literal: 999999 }, onFail: 'NEEDS_REVIEW' }),
        ],
        {},
      );
      expect(result.reasonCodes).toEqual([
        'AMOUNT_LTE_FAILED',
        'AMOUNT_GTE_FAILED',
      ]);
    });

    it('todas las reglas cumplidas agregan RULES_PASSED', () => {
      expect(
        run([rule({}), rule({ op: 'lte', ref: { literal: 200000 } })]),
      ).toMatchObject({ verdict: 'VALID', reasonCodes: ['RULES_PASSED'] });
    });

    it('informa el resultado de cada regla en orden', () => {
      const result = run([rule({}), rule({ ref: { literal: 999999 } })]);
      expect(result.results.map((r) => r.status)).toEqual(['PASS', 'FAIL']);
      expect(result.results.map((r) => r.index)).toEqual([0, 1]);
    });

    it('limita los motivos a 10', () => {
      const many = Array.from({ length: 20 }, (_, i) =>
        rule({
          field: i % 2 ? 'currency' : 'reference',
          op: 'eq',
          ref: { literal: `x${i}` },
        }),
      );
      expect(run(many).reasonCodes.length).toBeLessThanOrEqual(10);
    });

    it('nunca es VALID si alguna regla no pasa', () => {
      const cases: Array<[RuleInput[], Fields]> = [
        [[rule({ ref: { literal: 999999 } })], {}],
        [[rule({})], { amount: null }],
        [[rule({ ref: 'grounding.x' })], {}],
      ];
      for (const [rules, extra] of cases) {
        expect(run(rules, extra).verdict).not.toBe('VALID');
      }
    });
  });
});

describe('política de veredicto con reglas', () => {
  const decide = (
    extra: Fields,
    rules: RuleInput[] = [],
    isExpectedDocument?: boolean,
  ) =>
    decideVerdict(
      { fields: fields(extra) as never, isExpectedDocument },
      { version: 1, rules } as never,
      context(),
    );

  it('un documento que no es el esperado es NOT_APPLICABLE, antes que cualquier otra cosa', () => {
    expect(decide({ legibility: 'UNREADABLE' }, [], false)).toEqual({
      verdict: 'NOT_APPLICABLE',
      reasonCodes: ['NOT_EXPECTED_DOCUMENT'],
    });
  });

  it('sin la marca de documento esperado se sigue evaluando', () => {
    expect(decide({}, [], undefined).verdict).toBe('VALID');
    expect(decide({}, [], true).verdict).toBe('VALID');
  });

  it('ilegible y parcial no llegan a evaluar reglas', () => {
    const failing = [rule({ ref: { literal: 999999 } })];
    expect(decide({ legibility: 'UNREADABLE' }, failing).verdict).toBe(
      'UNREADABLE',
    );
    expect(decide({ legibility: 'PARTIAL' }, failing).verdict).toBe(
      'NEEDS_REVIEW',
    );
  });

  it('legible con una regla incumplida es INVALID', () => {
    expect(decide({}, [rule({ ref: { literal: 999999 } })])).toMatchObject({
      verdict: 'INVALID',
      reasonCodes: ['AMOUNT_GTE_FAILED'],
    });
  });
});

describe('resúmenes de los códigos de regla', () => {
  it.each([
    'AMOUNT_MISSING',
    'DATE_MISSING',
    'AMOUNT_GTE_FAILED',
    'DATE_WITHIN_DAYS_FAILED',
    'RECIPIENT_FUZZY_FAILED',
    'RECIPIENT_CONTAINS_FAILED',
    'CURRENCY_EQ_FAILED',
    'GROUNDING_UNAVAILABLE',
    'RULE_OPERAND_INVALID',
    'RULES_PASSED',
    'NOT_EXPECTED_DOCUMENT',
  ])('%s tiene un resumen fijo que cabe en 160 caracteres', (code) => {
    const text = summarize([code]);
    expect(text).not.toBe('Resultado sin descripción.');
    expect(text.length).toBeLessThanOrEqual(MAX_HUMAN_SUMMARY);
  });

  it('los resúmenes nunca incluyen valores de la imagen', () => {
    expect(summarize(['AMOUNT_GTE_FAILED'])).not.toMatch(/\d/);
  });

  it('un código de campo desconocido usa el texto genérico', () => {
    expect(summarize(['SECRET_MISSING'])).toBe('Resultado sin descripción.');
  });
});

describe('comparación de texto', () => {
  it('normaliza tildes, mayúsculas y puntuación', () => {
    expect(normalizeText('  Spá   DEMO, S.A.S. ')).toBe('spa demo sas');
    expect(normalizeText('J.P. Morgan')).toBe('jp morgan');
  });

  it('containsTokens exige palabras completas', () => {
    expect(containsTokens('Spa Demo', 'demo')).toBe(true);
    expect(containsTokens('Spanish', 'spa')).toBe(false);
    expect(containsTokens('Spa Demo', '')).toBe(false);
  });

  it('fuzzySimilarity: idéntico 1, sin relación bajo, vacío 0', () => {
    expect(fuzzySimilarity('Spa Demo', 'spa demo')).toBe(1);
    expect(fuzzySimilarity('Spa Demo', 'Juan Gomez')).toBeLessThan(0.5);
    expect(fuzzySimilarity('', 'algo')).toBe(0);
    expect(fuzzySimilarity('a', 'b')).toBe(0);
  });
});

describe('within_days con fechas que no existen', () => {
  it.each(['2026-02-31', '2026-04-31', '2026-13-01', 'no-es-fecha'])(
    '%s pide revisión en lugar de interpretarse como otra fecha',
    (date) => {
      const result = evaluateRules(
        fields({ date }) as never,
        {
          version: 1,
          rules: [
            rule({ field: 'date', op: 'within_days', ref: { literal: 3 } }),
          ],
        } as never,
        context(),
      );
      expect(result.verdict).toBe('NEEDS_REVIEW');
      expect(result.reasonCodes).toEqual(['RULE_OPERAND_INVALID']);
    },
  );
});
