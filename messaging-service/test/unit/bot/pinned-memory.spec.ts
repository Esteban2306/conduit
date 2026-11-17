import {
  ActionMemoryEntry,
  ConversationService,
} from 'src/bot/conversation/ConversationService';
import {
  MAX_PINNED_MEMORY,
  PINNED_MEMORY_KEY,
  pinEntry,
  pinnedEntriesOf,
} from 'src/bot/conversation/pinned-memory';
import { ContextBuilder } from 'src/bot/prompt/ContextBuilder';

const entry = (
  herramienta: string,
  resultado: string,
  en: string,
  estado = 'SUCCESS',
): ActionMemoryEntry => ({
  herramienta,
  parametros: '{}',
  estado,
  resultado,
  en,
});

const REGISTERED = '{"registered":true,"firstName":"Luz","termsAccepted":true}';

describe('memoria fija de herramientas', () => {
  it('guarda el último resultado por herramienta y reemplaza el anterior', () => {
    const first = pinEntry(
      undefined,
      entry(
        'consultar_cliente',
        '{"registered":false}',
        '2026-11-17T13:50:00Z',
      ),
    );
    const second = pinEntry(
      first,
      entry('consultar_cliente', REGISTERED, '2026-11-17T13:56:00Z'),
    );
    expect(Object.keys(second)).toEqual(['consultar_cliente']);
    expect(second.consultar_cliente.resultado).toBe(REGISTERED);
  });

  it('conserva como máximo las herramientas más recientes', () => {
    let pinned: unknown;
    for (let i = 0; i < MAX_PINNED_MEMORY + 2; i++) {
      pinned = pinEntry(
        pinned,
        entry(`t${i}`, '{}', `2026-11-17T13:5${i}:00Z`),
      );
    }
    const names = pinnedEntriesOf(pinned).map((e) => e.herramienta);
    expect(names).toHaveLength(MAX_PINNED_MEMORY);
    expect(names).not.toContain('t0');
    expect(names).toContain(`t${MAX_PINNED_MEMORY + 1}`);
  });

  it('tolera datos corruptos en el contexto', () => {
    expect(pinnedEntriesOf(null)).toEqual([]);
    expect(pinnedEntriesOf('x')).toEqual([]);
    expect(pinnedEntriesOf([entry('a', '{}', 'x')])).toEqual([]);
    expect(pinnedEntriesOf({ a: { herramienta: 1 }, b: null })).toEqual([]);
  });
});

describe('ContextBuilder — datos vigentes', () => {
  it('el perfil del cliente sigue visible aunque muchas acciones largas lo saquen de la memoria', () => {
    const greeting = entry(
      'consultar_cliente',
      REGISTERED,
      '2026-11-17T13:50:48Z',
    );
    const later = Array.from({ length: 8 }, (_, i) =>
      entry(
        i % 2 ? 'disponibilidad_combo' : 'listar_tratamientos',
        `{"items":"${'x'.repeat(580)}"}`,
        `2026-11-17T13:5${i}:30Z`,
      ),
    );
    const { block } = new ContextBuilder().build(
      {
        memoriaAcciones: later,
        [PINNED_MEMORY_KEY]: pinEntry(undefined, greeting),
      },
      null,
    );

    expect(block).toContain('Datos vigentes de esta conversación');
    expect(block).toContain('"registered":true');
    expect(block).toContain('no se los vuelvas a pedir');
    expect(block).not.toContain('memoriaFija=');
    expect(block!.indexOf('Datos vigentes')).toBeLessThan(
      block!.indexOf('Acciones ya realizadas'),
    );
  });

  it('sin datos fijados no agrega nada nuevo', () => {
    const { block } = new ContextBuilder().build(
      { [PINNED_MEMORY_KEY]: null },
      null,
    );
    expect(block).toBeNull();
  });
});

describe('ConversationService — fijar resultados', () => {
  function serviceWith(context: Record<string, unknown>) {
    const service = new ConversationService(
      {} as any,
      { publish: jest.fn() } as any,
    );
    jest.spyOn(service, 'getContext').mockResolvedValue(context);
    const update = jest
      .spyOn(service, 'updateContext')
      .mockResolvedValue(undefined);
    return { service, update };
  }

  it('fija un resultado correcto de una herramienta marcada', async () => {
    const { service, update } = serviceWith({ memoriaAcciones: [] });
    await service.appendActionMemory(
      'c1',
      entry('consultar_cliente', REGISTERED, '2026-11-17T13:50:48Z'),
      { pin: true },
    );
    const patch = update.mock.calls[0][1].contextPatch!;
    expect(patch.memoriaAcciones).toHaveLength(1);
    expect(
      (patch[PINNED_MEMORY_KEY] as Record<string, ActionMemoryEntry>)
        .consultar_cliente.resultado,
    ).toBe(REGISTERED);
  });

  it('un fallo no reemplaza el dato fijado', async () => {
    const { service, update } = serviceWith({});
    await service.appendActionMemory(
      'c1',
      entry(
        'consultar_cliente',
        'timeout',
        '2026-11-17T13:56:00Z',
        'TECHNICAL_ERROR',
      ),
      { pin: true },
    );
    expect(update.mock.calls[0][1].contextPatch).not.toHaveProperty(
      PINNED_MEMORY_KEY,
    );
  });

  it('sin la marca se comporta como antes', async () => {
    const { service, update } = serviceWith({});
    await service.appendActionMemory(
      'c1',
      entry('listar_tratamientos', '{}', '2026-11-17T13:52:00Z'),
    );
    expect(update.mock.calls[0][1].contextPatch).not.toHaveProperty(
      PINNED_MEMORY_KEY,
    );
  });

  it('empezar de cero también limpia los datos fijados', async () => {
    const prisma = { conversation: { update: jest.fn() } };
    const service = new ConversationService(
      prisma as any,
      { publish: jest.fn() } as any,
    );
    const update = jest
      .spyOn(service, 'updateContext')
      .mockResolvedValue(undefined);
    await service.resetConversation('c1', new Date('2026-11-17T14:00:00Z'));
    expect(update.mock.calls[0][1].contextPatch).toMatchObject({
      memoriaAcciones: [],
      [PINNED_MEMORY_KEY]: null,
    });
  });
});
