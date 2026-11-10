import { readPath, toGroundingValue } from 'src/bot/specialists/value-path';
import {
  referencedGroundingKeys,
  undeclaredGroundingKeys,
} from 'src/bot/specialists/grounding-config';

describe('readPath', () => {
  const body = {
    data: {
      anticipo: { monto: 30000, moneda: 'COP' },
      items: [{ id: 'a' }, { id: 'b' }],
    },
    plano: 5,
  };

  it('lee rutas anidadas, índices de arreglo y valores planos', () => {
    expect(readPath(body, 'data.anticipo.monto')).toBe(30000);
    expect(readPath(body, 'data.items.1.id')).toBe('b');
    expect(readPath(body, 'plano')).toBe(5);
  });

  it('devuelve undefined si la ruta no existe o atraviesa un valor plano', () => {
    expect(readPath(body, 'data.nada')).toBeUndefined();
    expect(readPath(body, 'plano.x')).toBeUndefined();
    expect(readPath(body, 'data.items.9.id')).toBeUndefined();
    expect(readPath(body, 'data.items.x')).toBeUndefined();
    expect(readPath(null, 'a')).toBeUndefined();
    expect(readPath('texto', 'a')).toBeUndefined();
  });

  it('no sigue segmentos peligrosos ni propiedades heredadas', () => {
    expect(readPath(body, '__proto__')).toBeUndefined();
    expect(readPath(body, 'data.constructor')).toBeUndefined();
    expect(readPath(body, 'data.prototype.x')).toBeUndefined();
    expect(readPath({}, 'toString')).toBeUndefined();
    expect(readPath([], 'length')).toBeUndefined();
  });
});

describe('readPath con claves peligrosas propias de un JSON recibido', () => {
  const hostile = JSON.parse(
    '{"__proto__":{"monto":5},"constructor":{"monto":6},"prototype":{"monto":7},"ok":{"monto":8}}',
  ) as unknown;

  it.each(['__proto__.monto', 'constructor.monto', 'prototype.monto'])(
    'no recorre %s aunque exista como clave propia',
    (path) => {
      expect(readPath(hostile, path)).toBeUndefined();
    },
  );

  it('las claves normales del mismo objeto sí se leen', () => {
    expect(readPath(hostile, 'ok.monto')).toBe(8);
  });
});

describe('toGroundingValue', () => {
  it('acepta números finitos, booleanos y textos acotados', () => {
    expect(toGroundingValue(30000)).toBe(30000);
    expect(toGroundingValue(0)).toBe(0);
    expect(toGroundingValue(true)).toBe(true);
    expect(toGroundingValue('  Spa Demo  ')).toBe('Spa Demo');
  });

  it('acepta un texto de hasta 1000 caracteres, como unas instrucciones de pago', () => {
    expect(toGroundingValue('x'.repeat(1000))).toBe('x'.repeat(1000));
    expect(toGroundingValue('x'.repeat(201))).toBe('x'.repeat(201));
  });

  it('rechaza lo que no es escalar o no es seguro', () => {
    for (const bad of [
      NaN,
      Infinity,
      '',
      '   ',
      'x'.repeat(1001),
      {},
      [],
      null,
      undefined,
    ]) {
      expect(toGroundingValue(bad)).toBeUndefined();
    }
  });
});

describe('claves de contexto de las reglas', () => {
  const rules = (refs: unknown[]) =>
    ({
      version: 1,
      rules: refs.map((ref) => ({
        field: 'amount',
        op: 'gte',
        ref,
        onFail: 'INVALID',
      })),
    }) as never;
  const source = (key: string) =>
    ({
      key,
      kind: 'TOOL',
      name: 't',
      maxAgeSeconds: 60,
      required: false,
    }) as never;

  it('junta solo las referencias a contexto, sin repetir', () => {
    const keys = referencedGroundingKeys(
      rules(['grounding.a', 'grounding.a', { literal: 5 }, 'grounding.b']),
    );
    expect([...keys].sort()).toEqual(['a', 'b']);
  });

  it('detecta las claves sin fuente declarada', () => {
    expect(
      undeclaredGroundingKeys(rules(['grounding.a', 'grounding.z']), [
        source('a'),
      ]),
    ).toEqual(['z']);
    expect(undeclaredGroundingKeys(rules([{ literal: 1 }]), [])).toEqual([]);
  });
});
