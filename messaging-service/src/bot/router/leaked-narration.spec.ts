import {
  looksEnglish,
  looksLikePlanning,
  withoutLeakedNarration,
} from './leaked-narration';

describe('lo que el modelo piensa en inglés nunca le llega a la clienta', () => {
  it('quita la explicación en inglés y deja el saludo', () => {
    const reply = `There's a team price in the chat: "Serán 200 para tu cabello" which means $200.000, but it doesn't say which service it refers to yet. I'll greet her now and ask how I can help, without saving the price until I know the service.

Hola, Luz, soy Sofía de Leonice Arenas Spa Capilar 🌿

Buenas tardes, ¿en qué te puedo ayudar hoy? 😊`;
    expect(withoutLeakedNarration(reply)).toEqual({
      content:
        'Hola, Luz, soy Sofía de Leonice Arenas Spa Capilar 🌿\n\nBuenas tardes, ¿en qué te puedo ayudar hoy? 😊',
      dropped: 1,
    });
  });

  it('no toca mensajes en español ni nombres de servicios en inglés', () => {
    for (const text of [
      'Hola, Luz, soy Sofía de Leonice Arenas Spa Capilar 🌿',
      'El *Spa coreano* dura 2 h y tiene un valor de $180.000. ¿Te lo aparto?',
      'Tenemos el kit Hair Repair Total Care a $95.000 🌿',
      'ok',
    ]) {
      expect(looksEnglish(text)).toBe(false);
      expect(withoutLeakedNarration(text).dropped).toBe(0);
    }
  });

  it('si todo viene en inglés no queda nada que enviar', () => {
    expect(
      withoutLeakedNarration(
        'I need to check the availability first and then I will ask her.',
      ).content,
    ).toBe('');
  });
});

describe('lo que el modelo piensa en español tampoco le llega', () => {
  it('quita el cálculo de la fecha que escribió antes del saludo', () => {
    const reply = `Hoy es lunes 23 de noviembre, así que "el miércoles de la otra semana" es el miércoles 2 de diciembre. Antes de buscar cupos necesito saber qué servicio te interesa.

Hola, Luz 🌿 ¿Qué servicio te gustaría agendar para el miércoles 2 de diciembre?`;
    expect(withoutLeakedNarration(reply)).toEqual({
      content:
        'Hola, Luz 🌿 ¿Qué servicio te gustaría agendar para el miércoles 2 de diciembre?',
      dropped: 1,
    });
  });

  it('no esconde la aclaración de que una promoción no aplica para su fecha', () => {
    const reply = `El Alisado tiene una promoción del 20 %, pero vence el 24 de noviembre, así que para el 2 de diciembre ya no aplicaría.

Para el miércoles 2 de diciembre hay estos cupos:`;
    expect(withoutLeakedNarration(reply)).toEqual({
      content: reply,
      dropped: 0,
    });
  });

  it('no toca lo que sí le habla a la clienta', () => {
    for (const text of [
      'El alisado dura 3 a 4 h, así que te sugiero venir temprano.',
      'Antes de agendar, ¿me confirmas qué servicio te interesa?',
      'Para el miércoles 2 de diciembre hay estos cupos:',
    ]) {
      expect(looksLikePlanning(text)).toBe(false);
    }
    const single =
      'Hoy es lunes, así que el cupo más cercano es mañana a las 8:00 a. m.';
    expect(withoutLeakedNarration(single).content).toBe(single);
  });
});
