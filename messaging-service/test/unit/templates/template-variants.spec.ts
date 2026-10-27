import { BadRequestException } from '@nestjs/common';
import { TemplateEngine } from 'src/core/templates/TemplateEngine';
import { TemplateService } from 'src/core/templates/TemplateService';

const MAIN =
  'Hola {{nombre}}, te recordamos tu cita el {{fecha}} a las {{hora}}.';
const V1 = '{{nombre}}, tu cita es el {{fecha}} a las {{hora}}. ¡Te esperamos!';
const V2 = 'Buen día {{nombre}}. Recuerda tu cita: {{fecha}}, {{hora}}.';

describe('TemplateEngine.pickBody', () => {
  const engine = new TemplateEngine();

  it('sin variantes devuelve siempre el mensaje principal', () => {
    expect(engine.pickBody(MAIN, [], 'm1')).toBe(MAIN);
    expect(engine.pickBody(MAIN, undefined, 'm1')).toBe(MAIN);
    expect(engine.pickBody(MAIN, 'no-es-lista', 'm1')).toBe(MAIN);
  });

  it('el mismo mensaje usa siempre el mismo texto, también al reintentar', () => {
    const first = engine.pickBody(MAIN, [V1, V2], 'msg-123');
    for (let i = 0; i < 20; i++) {
      expect(engine.pickBody(MAIN, [V1, V2], 'msg-123')).toBe(first);
    }
  });

  it('reparte los destinatarios entre todas las redacciones', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 600; i++) {
      const body = engine.pickBody(MAIN, [V1, V2], `msg-${i}`);
      counts.set(body, (counts.get(body) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual([MAIN, V1, V2].sort());
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(140);
    }
  });

  it('ignora variantes vacías o que no son texto', () => {
    expect(engine.pickBody(MAIN, ['', '  ', 5, null], 'x')).toBe(MAIN);
  });
});

describe('TemplateService: validación de variantes', () => {
  function service(current?: Record<string, unknown>) {
    const created: Array<Record<string, unknown>> = [];
    const prisma = {
      template: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return data;
        }),
        findUnique: jest.fn(async () => current ?? null),
        update: jest.fn(async ({ data }: { data: unknown }) => data),
      },
    };
    const svc = new TemplateService(prisma as never, new TemplateEngine(), {
      get: () => undefined,
    } as never);
    return { svc, prisma, created };
  }
  const dto = (extra: Record<string, unknown> = {}) =>
    ({
      name: 'Recordatorio',
      channel: 'WHATSAPP',
      bodyHandlebars: MAIN,
      ...extra,
    }) as never;

  it('acepta hasta 3 variantes con las mismas variables y las guarda', async () => {
    const { svc, created } = service();
    await svc.create('t', dto({ bodyVariants: [V1, V2] }));
    expect(created[0].bodyVariants).toEqual([V1, V2]);
  });

  it('sin variantes guarda una lista vacía', async () => {
    const { svc, created } = service();
    await svc.create('t', dto());
    expect(created[0].bodyVariants).toEqual([]);
  });

  it('rechaza una variante que pierde una variable del mensaje principal', async () => {
    const { svc } = service();
    await expect(
      svc.create(
        't',
        dto({ bodyVariants: ['{{nombre}}, tu cita es el {{fecha}}.'] }),
      ),
    ).rejects.toThrow(/hora/);
  });

  it('rechaza más de 3 variantes, repetidas y con sintaxis inválida', async () => {
    const { svc } = service();
    await expect(
      svc.create('t', dto({ bodyVariants: [V1, V2, `${V1} 3`, `${V1} 4`] })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create('t', dto({ bodyVariants: [V1, V1] })),
    ).rejects.toThrow(/distintas/);
    await expect(
      svc.create(
        't',
        dto({ bodyVariants: ['{{#if}} {{nombre}} {{fecha}} {{hora}}'] }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cambiar el mensaje principal vuelve a validar las variantes guardadas', async () => {
    const { svc } = service({
      id: 't1',
      bodyHandlebars: MAIN,
      bodyVariants: [V1],
      tags: [],
    });
    await expect(
      svc.update(
        't1',
        { bodyHandlebars: `${MAIN} Código: {{codigo}}` } as never,
        't',
      ),
    ).rejects.toThrow(/codigo/);
  });
});
