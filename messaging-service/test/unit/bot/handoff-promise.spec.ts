import { promisesHumanContact } from 'src/bot/handoff/handoff-promise';

describe('promisesHumanContact', () => {
  it.each([
    'Tuvimos un inconveniente al procesar tu solicitud. Una persona de nuestro equipo se pondrá en contacto contigo en breve.',
    'Una persona del equipo te escribirá por este chat.',
    'Ya avisé al equipo, te responderán pronto.',
    'Ya le avisé al equipo para que lo revise.',
    'Nos pondremos en contacto contigo hoy mismo.',
    'Una persona del equipo continuará la conversación por este mismo chat.',
    'El equipo ya fue notificado.',
    'Gracias. Alguien te contactará para confirmar.',
    'Perfecto, te llamará una asesora en unos minutos.',
    'UNA PERSONA DEL SPA TE CONTACTARÁ',
  ])('"%s" es una promesa', (text) => {
    expect(promisesHumanContact(text)).toBe(true);
  });

  it.each([
    'Puedo pasarte con una persona del equipo si lo prefieres.',
    '¿Quieres que te pase con una persona del equipo?',
    'Si deseas, una persona del equipo puede ayudarte.',
    'Si prefieres, te paso con alguien del equipo.',
    'No hay horario ese día. ¿Te sirve el martes a las 9:00?',
    'Tu cita quedó agendada para el lunes a las 9:00.',
    'Para dudas médicas lo mejor es consultar a una persona profesional.',
    'El equipo del spa atiende de lunes a sábado.',
    'Puedes escribirnos cuando quieras y te atendemos.',
    '',
  ])('"%s" NO es una promesa', (text) => {
    expect(promisesHumanContact(text)).toBe(false);
  });

  it('una oferta y una promesa en el mismo mensaje: manda la promesa', () => {
    expect(
      promisesHumanContact(
        'Puedo ayudarte con otra fecha. Una persona del equipo te escribirá hoy.',
      ),
    ).toBe(true);
  });
});
