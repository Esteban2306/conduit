import { blockedToolsForTurn, TurnTool } from './turn-tools';

const tool = (
  name: string,
  extra: Partial<Omit<TurnTool, 'spec'>> = {},
): TurnTool => ({
  spec: { name },
  readOnly: false,
  ...extra,
});

const TOOLS = [
  tool('consultar_disponibilidad', { readOnly: true }),
  tool('consultar_cliente', { readOnly: true, pinResultInMemory: true }),
  tool('crear_reserva_whatsapp'),
  tool('pasar_a_persona', { pausesBotMinutes: 240 }),
];

describe('herramientas bloqueadas en el turno', () => {
  it('en un turno normal no bloquea nada', () => {
    expect(
      blockedToolsForTurn(TOOLS, { handoffQuiet: false, affirmsSlot: false })
        .size,
    ).toBe(0);
  });

  it('si la clienta aceptó el horario bloquea las consultas y el traspaso, no la reserva ni lo fijado en memoria', () => {
    const blocked = blockedToolsForTurn(TOOLS, {
      handoffQuiet: false,
      affirmsSlot: true,
    });
    expect([...blocked.keys()].sort()).toEqual([
      'consultar_disponibilidad',
      'pasar_a_persona',
    ]);
    expect(blocked.get('consultar_disponibilidad')).toContain(
      'crear_reserva_whatsapp',
    );
  });

  it('con el equipo atendiendo bloquea solo lo que vuelve a pasar el chat', () => {
    const blocked = blockedToolsForTurn(TOOLS, {
      handoffQuiet: true,
      affirmsSlot: false,
    });
    expect([...blocked.keys()]).toEqual(['pasar_a_persona']);
    expect(blocked.get('pasar_a_persona')).toContain('ya está atendiendo');
  });
});
