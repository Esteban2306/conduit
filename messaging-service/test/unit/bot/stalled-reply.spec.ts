import {
  announcesPendingCheck,
  asksForDay,
  deniesOffer,
  isNoReply,
  leaksInternals,
  scrubInternals,
} from 'src/bot/router/stalled-reply';

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

describe('asksForDay', () => {
  it.each([
    '¿Qué día te gustaría venir?',
    'Si me dices qué día te queda mejor, te busco los cupos.',
    'La Terapia de hidratación cuesta $200.000. ¿Te busco los horarios más cercanos?',
    '¿Quieres que te busque los cupos más cercanos?',
  ])('pide algo en vez de ofrecer cupos: %s', (reply) => {
    expect(asksForDay(reply)).toBe(true);
  });

  it.each([
    'El cupo más cercano es el viernes a las 2:00 p. m. ¿Te lo aparto?',
    '¿Cuál de estos horarios te queda mejor: viernes 2:00 p. m. o sábado 7:00 a. m.?',
  ])('ofrecer cupos no cuenta: %s', (reply) => {
    expect(asksForDay(reply)).toBe(false);
  });
});

describe('deniesOffer', () => {
  it('reconoce cuando dice que algo no existe', () => {
    expect(deniesOffer('No tenemos servicio de nutrición en el spa')).toBe(
      true,
    );
    expect(deniesOffer('No contamos con citas de nutrición')).toBe(true);
    expect(deniesOffer('No hay cupo ese día')).toBe(true);
    expect(deniesOffer('Tenemos la Terapia de nutrición')).toBe(false);
  });
});

describe('detalles internos', () => {
  const tools = ['info_negocio', 'crear_reserva_whatsapp'];
  it('detecta ids, nombres de herramientas y jerga técnica', () => {
    expect(leaksInternals('Consulta con info_negocio cómo pagar.', tools)).toBe(
      true,
    );
    expect(leaksInternals('El ID que usé es de otro servicio.', tools)).toBe(
      true,
    );
    expect(
      leaksInternals(
        'Tu reserva 0b0f3c64-6a3f-4a8c-9a56-2f0d6a1b7c11 quedó.',
        tools,
      ),
    ).toBe(true);
    expect(leaksInternals('Tu cita quedó para el viernes 🌿', tools)).toBe(
      false,
    );
  });

  it('quita solo la frase técnica y deja el resto', () => {
    expect(
      scrubInternals(
        'Tu cita quedó para el viernes. Usé el id equivocado.',
        tools,
      ),
    ).toBe('Tu cita quedó para el viernes.');
  });
});
