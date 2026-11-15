import { isIgnorableAcknowledgement } from 'src/bot/router/acknowledgement';

const CLOSED = 'Tu cita quedó agendada para el 15. Te esperamos.';
const OPEN = '¿Confirmas tu cita del 15 a las 8?';

describe('isIgnorableAcknowledgement — acuses sin pregunta abierta', () => {
  it.each([
    'ok',
    'Ok!',
    'oki',
    'okeyy',
    'ok perfecto',
    'listo, gracias',
    'Gracias!',
    'graciaaas',
    'muchas gracias',
    'mil gracias 🙏',
    'de nada',
    'súper',
    'SUPER!!',
    'dale',
    'vale 👍',
    '👍🏻',
    '🙏',
    '❤️',
    'chao',
    'hasta luego',
    'entendido',
    'bueno gracias',
    'ya',
    'sii',
  ])('ignora "%s"', (text) => {
    expect(isIgnorableAcknowledgement(text, CLOSED)).toBe(true);
  });
});

describe('isIgnorableAcknowledgement — nunca ignora contenido real', () => {
  it.each([
    'ok 3pm',
    'ok a las 3',
    'ok pero mejor el viernes',
    'no, mejor a las 3',
    'si no hay otra',
    'sí y también quiero otra cita',
    'ok?',
    '¿ok?',
    'gracias, una pregunta',
    'listo, ya pagué',
    'perfecto 2 personas',
    '🔥',
    '😡',
    'de nada pero no vino',
    '',
    '   ',
  ])('procesa "%s"', (text) => {
    expect(isIgnorableAcknowledgement(text, CLOSED)).toBe(false);
  });
});

describe('isIgnorableAcknowledgement — pregunta abierta, lote y tarea cerrada', () => {
  it.each([
    'sí',
    'si',
    'no',
    'ok',
    'listo',
    'dale',
    'Sí.',
    '👍',
    'ok perfecto',
  ])('procesa "%s" cuando el bot hizo una pregunta', (text) => {
    expect(isIgnorableAcknowledgement(text, OPEN)).toBe(false);
  });

  it('detecta la pregunta aunque no termine el mensaje ni abra con ¿', () => {
    expect(
      isIgnorableAcknowledgement(
        'ok',
        '¿Confirmo las 3? Avísame cuando puedas.',
      ),
    ).toBe(false);
    expect(
      isIgnorableAcknowledgement('ok', 'Quedas para el viernes, ¿vale'),
    ).toBe(false);
  });

  it('un mensaje con contenido no depende de la pregunta del bot', () => {
    expect(isIgnorableAcknowledgement('sí, para el viernes', null)).toBe(false);
  });

  it('sin mensaje previo del bot, el acuse se ignora', () => {
    expect(isIgnorableAcknowledgement('gracias', null)).toBe(true);
  });

  it('si ya hay un lote del cliente sin responder, el acuse se suma al lote', () => {
    expect(isIgnorableAcknowledgement('ok', CLOSED, true)).toBe(false);
  });

  it('con la tarea terminada ignora el relleno aunque el bot haya cerrado con una pregunta', () => {
    expect(isIgnorableAcknowledgement('ok', '¿Algo más?', false, true)).toBe(
      true,
    );
    expect(
      isIgnorableAcknowledgement('gracias', '¿Algo más?', false, true),
    ).toBe(true);
    expect(isIgnorableAcknowledgement('ok', '¿Algo más?', false, false)).toBe(
      false,
    );
  });

  it('con la tarea terminada tampoco ignora contenido real', () => {
    expect(
      isIgnorableAcknowledgement(
        'ok, y cuánto cuesta',
        '¿Algo más?',
        false,
        true,
      ),
    ).toBe(false);
  });
});
