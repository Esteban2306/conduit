import {
  ContextBuilder,
  MAX_ACTION_MEMORY_CHARS,
  MAX_SUMMARY_CHARS,
} from 'src/bot/prompt/ContextBuilder';
import {
  limitToolData,
  MAX_TOOL_RESULT_CHARS,
} from 'src/bot/tools/tool-result-limit';
import { formatTurnLine, maskChat } from 'src/bot/router/turn-trace';

const builder = new ContextBuilder();

describe('ContextBuilder: presupuesto del bloque dinámico', () => {
  it('las claves internas del bot nunca llegan al prompt', () => {
    const { block } = builder.build(
      {
        clientName: 'Diana',
        activeFlow: { key: 'booking', startedAt: 'x' },
        taskDoneAt: '2026-10-27T10:00:00Z',
        optedOutAt: '2026-10-27T10:00:00Z',
        handoffAt: '2026-10-27T10:00:00Z',
        handoffReason: 'Fallo técnico',
        failureStreaks: { crear_reserva: { code: 'SLOT', count: 2 } },
        closedAt: '2026-10-27T10:00:00Z',
        aiFallbackNotified: true,
        abuseAt: 'x',
        spamNotifiedAt: 'x',
      } as never,
      null,
    );
    expect(block).toBe('Contexto: clientName=Diana');
  });

  it('un resumen largo se recorta conservando lo más reciente', () => {
    const summary = `${'A'.repeat(3000)}FINAL`;
    const { block } = builder.build({} as never, summary);
    expect(block).toContain('FINAL');
    expect(block!.length).toBeLessThan(MAX_SUMMARY_CHARS + 120);
  });

  it('la memoria de acciones tiene presupuesto y conserva las más recientes', () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({
      en: `t${i}`,
      herramienta: `tool${i}`,
      parametros: 'p'.repeat(200),
      estado: 'SUCCESS',
      resultado: 'r'.repeat(600),
    }));
    const { block } = builder.build(
      { memoriaAcciones: entries } as never,
      null,
    );
    expect(block!.length).toBeLessThan(MAX_ACTION_MEMORY_CHARS + 400);
    expect(block).toContain('tool7');
    expect(block).not.toContain('tool0(');
  });

  it('con poco contenido no recorta nada', () => {
    const { block } = builder.build(
      {
        memoriaAcciones: [
          {
            en: 't',
            herramienta: 'consultar_cliente',
            parametros: '{}',
            estado: 'SUCCESS',
            resultado: 'ok',
          },
        ],
      } as never,
      'Quiere agendar uñas.',
    );
    expect(block).toContain('Quiere agendar uñas.');
    expect(block).toContain('consultar_cliente');
  });
});

describe('limitToolData', () => {
  it('un resultado normal no se toca', () => {
    const data = { registered: true, name: 'Diana' };
    const limited = limitToolData(data);
    expect(limited).toEqual({
      data,
      chars: JSON.stringify(data).length,
      truncated: false,
    });
  });

  it('una lista enorme se recorta por elementos y avisa cuántos faltan', () => {
    const items = Array.from({ length: 400 }, (_, i) => ({
      id: `id-${i}`,
      name: `Tratamiento ${i}`,
      description: 'x'.repeat(40),
    }));
    const limited = limitToolData({ tratamientos: items });
    expect(limited.truncated).toBe(true);
    expect(limited.chars).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    const kept = (limited.data as { tratamientos: unknown[] }).tratamientos;
    expect(kept.length).toBeGreaterThan(5);
    expect(kept[kept.length - 1]).toEqual({
      omitidos: items.length - (kept.length - 1),
    });
    expect(kept[0]).toEqual(items[0]);
  });

  it('conserva los campos pequeños del mismo resultado', () => {
    const limited = limitToolData({
      status: 'SUCCESS',
      total: 400,
      lista: Array.from({ length: 400 }, (_, i) => ({
        i,
        texto: 'y'.repeat(60),
      })),
    });
    const data = limited.data as { status: string; total: number };
    expect(data.status).toBe('SUCCESS');
    expect(data.total).toBe(400);
    expect(limited.chars).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });

  it('un texto gigante se corta con una marca', () => {
    const limited = limitToolData('z'.repeat(20000));
    expect(limited.truncated).toBe(true);
    expect(limited.chars).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });

  it('datos nulos o vacíos pasan', () => {
    expect(limitToolData(null).truncated).toBe(false);
    expect(limitToolData(undefined).truncated).toBe(false);
  });
});

describe('formatTurnLine', () => {
  it('resume el turno en una línea con la correlación, sin el número completo', () => {
    expect(maskChat('573108525522')).toBe('***5522');
    const line = formatTurnLine({
      correlationId: 'abc-123',
      chat: maskChat('573108525522'),
      route: 'ia-reducida:booking',
      model: 'claude-haiku-5-5',
      llmCalls: 3,
      input: 17000,
      cacheRead: 14000,
      cacheWrite: 0,
      output: 250,
      ms: 6200,
      tools: [
        {
          name: 'consultar_cliente',
          ok: true,
          ms: 30,
          bytes: 220,
          truncated: false,
        },
        {
          name: 'listar_tratamientos',
          ok: false,
          ms: 45,
          bytes: 6000,
          truncated: true,
        },
      ],
      flags: ['resultado-recortado'],
    });
    expect(line).toBe(
      'Turno corr=abc-123 chat=***5522 ruta=ia-reducida:booking modelo=claude-haiku-5-5 llm=3 in=17000 caché=14000/0 out=250 ms=6200 herramientas=consultar_cliente(30ms,220B),listar_tratamientos!(45ms,6000B,recortado) banderas=resultado-recortado',
    );
    expect(line).not.toContain('573108525522');
  });
});
