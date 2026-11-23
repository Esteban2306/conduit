import { looksEnglish, withoutEnglishNarration } from './leaked-narration';

describe('lo que el modelo piensa en inglés nunca le llega a la clienta', () => {
  it('quita la explicación en inglés y deja el saludo', () => {
    const reply = `There's a team price in the chat: "Serán 200 para tu cabello" which means $200.000, but it doesn't say which service it refers to yet. I'll greet her now and ask how I can help, without saving the price until I know the service.

Hola, Luz, soy Sofía de Leonice Arenas Spa Capilar 🌿

Buenas tardes, ¿en qué te puedo ayudar hoy? 😊`;
    expect(withoutEnglishNarration(reply)).toEqual({
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
      expect(withoutEnglishNarration(text).dropped).toBe(0);
    }
  });

  it('si todo viene en inglés no queda nada que enviar', () => {
    expect(
      withoutEnglishNarration(
        'I need to check the availability first and then I will ask her.',
      ).content,
    ).toBe('');
  });
});
