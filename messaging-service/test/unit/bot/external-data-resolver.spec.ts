import { ExternalDataResolver } from 'src/external/ExternalDataResolver';

const row = (namespace: string, key: string, value: string) => ({
  namespace,
  key,
  fullKey: `${namespace}.${key}`,
  value,
});

function resolver(rows: ReturnType<typeof row>[]) {
  return new ExternalDataResolver(
    {} as never,
    { get: () => Promise.resolve(rows) } as never,
  );
}

describe('ExternalDataResolver', () => {
  it('compila los datos del negocio por espacio de nombres', async () => {
    const out = await resolver([
      row('negocio', 'direccion', 'Calle 1 # 2-3'),
      row('negocio', 'anticipo', '$50.000'),
    ]).resolve('bot');
    expect(out.compiledBlock).toBe(
      'Datos del negocio:\nnegocio:\n  direccion: Calle 1 # 2-3\n  anticipo: $50.000',
    );
    expect(out.variables).toEqual({
      'negocio.direccion': 'Calle 1 # 2-3',
      'negocio.anticipo': '$50.000',
    });
  });

  it('un dato borrado (valor vacío) no llega al prompt', async () => {
    const out = await resolver([
      row('negocio', 'direccion', ''),
      row('negocio', 'anticipo', '   '),
      row('negocio', 'horario', 'lunes 8:00'),
    ]).resolve('bot');
    expect(out.compiledBlock).toBe(
      'Datos del negocio:\nnegocio:\n  horario: lunes 8:00',
    );
    expect(out.compiledBlock).not.toContain('direccion');
  });

  it('si todo está vacío no agrega bloque', async () => {
    const out = await resolver([row('negocio', 'direccion', '')]).resolve(
      'bot',
    );
    expect(out).toEqual({ variables: {}, compiledBlock: null });
  });

  it('permite valores de hasta 500 caracteres (instrucciones de pago) y hasta 20 variables', async () => {
    const long = 'x'.repeat(700);
    const many = Array.from({ length: 25 }, (_, i) =>
      row('negocio', `k${i}`, 'v'),
    );
    const out = await resolver([row('negocio', 'pago', long), ...many]).resolve(
      'bot',
    );
    expect(out.compiledBlock).toContain(`pago: ${'x'.repeat(500)}\n`);
    expect(out.compiledBlock).not.toContain('x'.repeat(501));
    expect(out.compiledBlock!.match(/^ {2}\w+: /gm)).toHaveLength(20);
  });
});
