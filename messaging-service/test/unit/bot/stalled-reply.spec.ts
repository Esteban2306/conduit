import { announcesPendingCheck, isNoReply } from 'src/bot/router/stalled-reply';

describe('announcesPendingCheck', () => {
  it.each([
    'Te doy el valor y los cupos ahora mismo 🌿\nAntes de reservar, necesito revisar los servicios y disponibilidad para darte un precio y horario exactos.',
    'Hola, Diana. Déjame revisar la disponibilidad real del spa para que tengas la información exacta.',
    'Dame un momento y te confirmo los horarios 😊',
    'Voy a consultar los cupos de mañana.',
    'Reviso y ya te cuento 🌿',
    'Permíteme verificar tu cita.',
  ])('detecta que anuncia una consulta sin hacerla: %s', (reply) => {
    expect(announcesPendingCheck(reply)).toBe(true);
  });

  it.each([
    'Tu cita de *Terapia de hidratación* sigue en pie mañana a las *8:00 a. m.* 🌿',
    '¿Te gustaría que revisemos cupos para alguno de estos?',
    'Te confirmo: *Alisado* el *viernes 20 de noviembre a las 8:00 a. m.* ¿Te lo aparto?',
    'Los cupos más cercanos son el *jueves a las 2:00 p. m.* y el *viernes a las 8:30 a. m.*',
    'Te paso el enlace de la web: https://leonicespa.com',
  ])('no confunde una respuesta completa con un anuncio: %s', (reply) => {
    expect(announcesPendingCheck(reply)).toBe(false);
  });
});

describe('isNoReply', () => {
  it('reconoce la marca aunque el modelo la rodee de texto, para no enviar su razonamiento', () => {
    expect(isNoReply('[NO_RESPONDER]')).toBe(true);
    expect(
      isNoReply(
        'Según las instrucciones, este mensaje debe recibir [NO_RESPONDER]. Así que no respondo.',
      ),
    ).toBe(true);
    expect(isNoReply('Hola, soy Sofía 🌿 ¿En qué te ayudo?')).toBe(false);
  });
});
