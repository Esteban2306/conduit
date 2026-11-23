import { withoutRepeatedGreeting } from './repeated-greeting';

describe('dentro de una conversación el bot saluda una sola vez', () => {
  it('quita el saludo con su nombre y deja la pregunta', () => {
    expect(
      withoutRepeatedGreeting(
        'Hola, Luz 🌿 ¿Qué servicio te gustaría agendar para el miércoles 2 de diciembre?',
      ),
    ).toBe(
      '¿Qué servicio te gustaría agendar para el miércoles 2 de diciembre?',
    );
  });

  it('quita también la presentación y un segundo saludo', () => {
    expect(
      withoutRepeatedGreeting(
        'Hola, Luz, soy Sofía de Leonice Arenas Spa Capilar 🌿\n\nBuenas tardes, ¿en qué te puedo ayudar hoy? 😊',
      ),
    ).toBe('¿en qué te puedo ayudar hoy? 😊');
    expect(
      withoutRepeatedGreeting(
        '¡Hola de nuevo, Marta! Claro, el cupo de las 8:00 a. m. sigue libre.',
      ),
    ).toBe('Claro, el cupo de las 8:00 a. m. sigue libre.');
  });

  it('sin saludo o si solo es un saludo, el mensaje queda igual', () => {
    for (const text of [
      'Claro, Luz. El alisado dura de 3 a 4 h.',
      '¡Hola, Luz! 🌿',
      'Holanda no está en la lista.',
    ]) {
      expect(withoutRepeatedGreeting(text)).toBe(text);
    }
  });
});
