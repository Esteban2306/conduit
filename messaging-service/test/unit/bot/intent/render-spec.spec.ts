import { getPath } from 'src/bot/intent/path';
import {
  applyTransform,
  evalCond,
  fillTemplate,
  renderTool,
} from 'src/bot/intent/render-spec';
import { isScheduledNow, validateSchedule } from 'src/bot/intent/schedule';

const OPTS = { timeZone: 'America/Bogota' };

describe('getPath', () => {
  const data = {
    a: { b: 1 },
    list: [{ n: 'x' }, { n: 'y' }],
    days: [{ r: [{ t: 1 }, { t: 2 }] }, { r: [{ t: 3 }] }],
  };

  it('lee rutas simples, índices y [*] aplanando', () => {
    expect(getPath(data, 'a.b')).toBe(1);
    expect(getPath(data, 'list[1].n')).toBe('y');
    expect(getPath(data, 'list[*].n')).toEqual(['x', 'y']);
    expect(getPath(data, 'days[*].r[*].t')).toEqual([1, 2, 3]);
    expect(getPath(data, '$.a.b')).toBe(1);
  });

  it('lo que no existe es undefined (o lista vacía con [*]) y no recorre el prototipo', () => {
    expect(getPath(data, 'a.zzz')).toBeUndefined();
    expect(getPath(data, 'nada[*].x')).toEqual([]);
    expect(getPath(data, 'a.constructor')).toBeUndefined();
    expect(getPath({}, '__proto__')).toBeUndefined();
  });
});

describe('evalCond', () => {
  const d = { n: 3, s: 'x', e: [], arr: [true, false] };
  it('compara, combina y niega', () => {
    expect(evalCond({ path: 'n', gt: 2 }, d)).toBe(true);
    expect(evalCond({ path: 'n', lt: 2 }, d)).toBe(false);
    expect(evalCond({ path: 's', equals: 'x' }, d)).toBe(true);
    expect(evalCond({ path: 's', notEquals: 'x' }, d)).toBe(false);
    expect(evalCond({ path: 'e', empty: true }, d)).toBe(true);
    expect(evalCond({ path: 'zz', exists: false }, d)).toBe(true);
    expect(evalCond({ path: 'arr', includes: true }, d)).toBe(true);
    expect(
      evalCond(
        { all: [{ path: 'n', gt: 1 }, { not: { path: 's', equals: 'y' } }] },
        d,
      ),
    ).toBe(true);
    expect(
      evalCond(
        {
          any: [
            { path: 'n', gt: 9 },
            { path: 's', equals: 'x' },
          ],
        },
        d,
      ),
    ).toBe(true);
  });
});

describe('applyTransform', () => {
  it('formatea fechas en la zona del negocio, dinero y texto', () => {
    expect(
      applyTransform('2026-11-02T15:00:00.000Z', 'datetime', 'America/Bogota'),
    ).toBe('lunes 2 de noviembre a las 10:00 am');
    expect(
      applyTransform('2026-11-02T15:00:00.000Z', 'time', 'America/Bogota'),
    ).toBe('10:00 am');
    expect(
      applyTransform('2026-11-02T15:00:00.000Z', 'date', 'America/Bogota'),
    ).toBe('lunes 2 de noviembre');
    expect(applyTransform(150000, 'money_cop', 'America/Bogota')).toBe(
      '$150.000',
    );
    expect(applyTransform('MARÍA', 'capitalize', 'America/Bogota')).toBe(
      'María',
    );
  });

  it('rechaza lo no válido: URL no http, fechas inválidas, vacíos y objetos', () => {
    expect(applyTransform('javascript:alert(1)', 'http_url', 'UTC')).toBeNull();
    expect(applyTransform('https://a.test/x', 'http_url', 'UTC')).toBe(
      'https://a.test/x',
    );
    expect(applyTransform('no es fecha', 'datetime', 'UTC')).toBeNull();
    expect(applyTransform('  ', undefined, 'UTC')).toBeNull();
    expect(applyTransform({ a: 1 }, undefined, 'UTC')).toBeNull();
  });
});

describe('renderTool', () => {
  const spec = {
    branches: [
      { when: { path: 'items', empty: true }, variant: 'none' },
      {
        variant: 'some',
        vars: {
          nombre: { path: 'who', transform: 'capitalize' as const },
          lista: {
            list: {
              path: 'items',
              item: '• {name} — {price}',
              groupBy: 'cat',
              groupHeader: '*{}*',
              limit: 3,
            },
          },
          extra: { path: 'extra', optional: true },
        },
      },
    ],
  };

  it('elige la rama, agrupa listas y deja vacías las opcionales', () => {
    const out = renderTool(
      {
        who: 'ANA',
        items: [
          { name: 'a', price: '$1', cat: 'X' },
          { name: 'b', price: '$2', cat: 'Y' },
          { name: 'c', price: '$3', cat: 'X' },
        ],
      },
      spec,
      OPTS,
    );
    expect(out).toEqual({
      variantKey: 'some',
      vars: {
        nombre: 'Ana',
        lista: '*X*\n• a — $1\n• c — $3\n\n*Y*\n• b — $2',
        extra: '',
      },
    });
    expect(renderTool({ items: [] }, spec, OPTS)?.variantKey).toBe('none');
  });

  it('devuelve null si falta una variable obligatoria, un campo de la lista o se pasa el tope', () => {
    expect(
      renderTool({ items: [{ name: 'a', price: '$1' }] }, spec, OPTS),
    ).toBeNull();
    expect(
      renderTool({ who: 'a', items: [{ name: 'a' }] }, spec, OPTS),
    ).toBeNull();
    expect(
      renderTool(
        {
          who: 'a',
          items: Array.from({ length: 4 }, () => ({ name: 'a', price: '1' })),
        },
        spec,
        OPTS,
      ),
    ).toBeNull();
  });

  it('sin rama que aplique no renderiza; usa $entity y $text como extras', () => {
    expect(
      renderTool(
        {},
        { branches: [{ when: { path: 'x', equals: 1 }, variant: 'a' }] },
        OPTS,
      ),
    ).toBeNull();
    const ok = renderTool(
      {},
      { branches: [{ variant: 'a', vars: { q: { path: '$entity' } } }] },
      { ...OPTS, extras: { entity: 'alisado' } },
    );
    expect(ok?.vars.q).toBe('alisado');
  });

  it('un texto con elementos de lista de texto plano usa {.}', () => {
    const out = renderTool(
      { notes: ['uno', 'dos'] },
      {
        branches: [
          {
            variant: 'a',
            vars: { n: { list: { path: 'notes', item: '{.}' } } },
          },
        ],
      },
      OPTS,
    );
    expect(out?.vars.n).toBe('uno\ndos');
  });

  it('el item admite alternativas con condición', () => {
    const out = renderTool(
      { rows: [{ n: 'a', p: 1 }, { n: 'b' }] },
      {
        branches: [
          {
            variant: 'a',
            vars: {
              l: {
                list: {
                  path: 'rows',
                  item: [
                    { when: { path: 'p', exists: true }, text: '{n} {p}' },
                    { text: '{n}' },
                  ],
                },
              },
            },
          },
        ],
      },
      OPTS,
    );
    expect(out?.vars.l).toBe('a 1\nb');
  });
});

describe('fillTemplate', () => {
  it('una variable ausente invalida; una vacía se sustituye y se compactan los saltos', () => {
    expect(fillTemplate('Hola {{a}}', {})).toBeNull();
    expect(
      fillTemplate('Hola {{a}}\n\n{{b}}\n\n{{c}}\n\nFin', {
        a: 'x',
        b: '',
        c: 'z',
      }),
    ).toBe('Hola x\n\nz\n\nFin');
  });
});

describe('programación (schedule)', () => {
  const tz = 'America/Bogota';
  const weekdays = {
    timeZone: tz,
    windows: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' }],
  };

  it('sin programación siempre aplica', () => {
    expect(isScheduledNow(null, new Date(), tz)).toBe(true);
  });

  it('respeta días y horas en la zona del negocio', () => {
    // lunes 2026-10-26 10:00 Bogotá = 15:00 UTC; domingo 25 a las 10:00 = 15:00 UTC del 25
    expect(isScheduledNow(weekdays, new Date('2026-10-26T15:00:00Z'), tz)).toBe(
      true,
    );
    expect(isScheduledNow(weekdays, new Date('2026-10-26T01:00:00Z'), tz)).toBe(
      false,
    );
    expect(isScheduledNow(weekdays, new Date('2026-10-25T15:00:00Z'), tz)).toBe(
      false,
    );
    expect(isScheduledNow(weekdays, new Date('2026-10-26T23:00:00Z'), tz)).toBe(
      false,
    );
  });

  it('una ventana nocturna cruza la medianoche', () => {
    const night = {
      timeZone: tz,
      windows: [{ days: [5], from: '22:00', to: '06:00' }],
    };
    // viernes 30 oct 23:00 Bogotá y sábado 31 03:00 Bogotá
    expect(isScheduledNow(night, new Date('2026-10-31T04:00:00Z'), tz)).toBe(
      true,
    );
    expect(isScheduledNow(night, new Date('2026-10-31T08:00:00Z'), tz)).toBe(
      true,
    );
    expect(isScheduledNow(night, new Date('2026-10-31T12:00:00Z'), tz)).toBe(
      false,
    );
  });

  it('respeta el rango de fechas (promoción con inicio y fin)', () => {
    const promo = {
      validFrom: '2026-11-01T00:00:00Z',
      validUntil: '2026-11-05T00:00:00Z',
    };
    expect(isScheduledNow(promo, new Date('2026-10-31T00:00:00Z'), tz)).toBe(
      false,
    );
    expect(isScheduledNow(promo, new Date('2026-11-02T00:00:00Z'), tz)).toBe(
      true,
    );
    expect(isScheduledNow(promo, new Date('2026-11-06T00:00:00Z'), tz)).toBe(
      false,
    );
  });

  it('valida la programación', () => {
    expect(validateSchedule(null)).toBeNull();
    expect(validateSchedule(weekdays)).toBeNull();
    expect(validateSchedule({ timeZone: 'No/Existe' })).toMatch(/Zona horaria/);
    expect(
      validateSchedule({
        windows: [{ days: [9], from: '08:00', to: '09:00' }],
      }),
    ).toMatch(/days/);
    expect(
      validateSchedule({ windows: [{ days: [1], from: '8am', to: '09:00' }] }),
    ).toMatch(/HH:MM/);
    expect(validateSchedule({ validFrom: 'ayer' })).toMatch(/validFrom/);
  });
});
