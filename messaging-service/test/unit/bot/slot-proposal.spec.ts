import {
  proposedSlotTimes,
  proposesSeveralSlots,
  proposesSingleSlot,
} from 'src/bot/intent/slot-proposal';

describe('propuesta de horario', () => {
  it('un solo día y hora es una propuesta concreta', () => {
    expect(
      proposesSingleSlot('¿Te aparto el viernes 20 a las 2:00 p. m.?'),
    ).toBe(true);
    expect(
      proposesSingleSlot('¿Te lo aparto a las 2 pm, a las 2:00 p. m.?'),
    ).toBe(true);
  });

  it('una lista de horarios no es una propuesta concreta', () => {
    const list =
      'Tengo cupo el sábado 21 a las 2:00 p. m., el domingo 22 a las 7:00 a. m. o el lunes 23 a las 8:00 a. m. ¿Cuál prefieres?';
    expect(proposedSlotTimes(list)).toEqual(['2:00p', '7:00a', '8:00a']);
    expect(proposesSeveralSlots(list)).toBe(true);
    expect(proposesSingleSlot(list)).toBe(false);
  });

  it('sin horas no hay propuesta de horario', () => {
    expect(proposesSingleSlot('¿Quieres agendarla?')).toBe(false);
    expect(proposesSeveralSlots('¿Quieres agendarla?')).toBe(false);
  });
});
