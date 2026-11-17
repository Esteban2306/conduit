import { coversNotice, withNotices } from 'src/bot/router/notice-coverage';
import {
  findRepeatedQuestion,
  questionsOf,
} from 'src/bot/router/repeated-question';

const LEO =
  'Sobre Leo: ahora las citas se atienden por aquí. Para otro tema puedes escribirle al WhatsApp +57 310 000 1122 🌿';

describe('aviso obligatorio en la respuesta', () => {
  it('lo da por incluido si la respuesta trae el número, con o sin +57 y espacios', () => {
    expect(coversNotice('Escríbele al 3100001122 cuando quieras', LEO)).toBe(
      true,
    );
    expect(coversNotice('Su WhatsApp es +57 310-000-1122', LEO)).toBe(true);
    expect(coversNotice('Para tu cita de hidratación tengo cupo', LEO)).toBe(
      false,
    );
  });

  it('sin datos clave, compara las palabras del aviso', () => {
    const notice = 'Recuerda traer el cabello limpio y seco para la valoración';
    expect(
      coversNotice(
        'Para la valoración recuerda traer el cabello limpio y seco',
        notice,
      ),
    ).toBe(true);
    expect(coversNotice('Tengo cupo mañana a las 9', notice)).toBe(false);
  });

  it('si falta, lo pone después del saludo y antes del resto', () => {
    const reply =
      'Hola, Luz, soy Sofía 🌿\n\nPara la hidratación tengo cupo mañana a las 2. ¿Te sirve?';
    expect(withNotices(reply, [LEO])).toBe(
      `Hola, Luz, soy Sofía 🌿\n\n${LEO}\n\nPara la hidratación tengo cupo mañana a las 2. ¿Te sirve?`,
    );
  });

  it('sin saludo va primero; si ya está, no lo duplica', () => {
    expect(withNotices('Tengo cupo mañana. ¿Te sirve?', [LEO])).toBe(
      `${LEO}\n\nTengo cupo mañana. ¿Te sirve?`,
    );
    const already = `Hola 🌿\n\nPuedes escribirle a Leo al +57 310 000 1122.\n\n¿Te ayudo con tu cita?`;
    expect(withNotices(already, [LEO])).toBe(already);
  });
});

describe('preguntas ya respondidas', () => {
  const line = (fromBot: boolean, content: string) => ({ fromBot, content });

  it('extrae las preguntas de un mensaje', () => {
    expect(
      questionsOf('Perfecto. ¿Me confirmas tu nombre completo? Gracias.'),
    ).toEqual(['¿Me confirmas tu nombre completo?']);
  });

  it('detecta que se vuelve a pedir lo que la clienta ya contestó', () => {
    const found = findRepeatedQuestion(
      'Antes de agendar, ¿me das tu nombre completo y tu fecha de nacimiento?',
      [
        line(
          true,
          'Para reservar, ¿me confirmas tu nombre completo y tu fecha de nacimiento?',
        ),
        line(false, 'Camila Torres, 3 de marzo de 1995'),
      ],
    );
    expect(found).toEqual({
      previous: '¿me confirmas tu nombre completo y tu fecha de nacimiento?',
      answer: 'Camila Torres, 3 de marzo de 1995',
    });
  });

  it('no lo marca si la pregunta anterior no tuvo respuesta', () => {
    expect(
      findRepeatedQuestion(
        '¿Me das tu nombre completo y fecha de nacimiento?',
        [line(true, '¿Me das tu nombre completo y fecha de nacimiento?')],
      ),
    ).toBeNull();
  });

  it('no confunde preguntas distintas ni cierres cortos', () => {
    const dialogue = [
      line(true, '¿Qué servicio te interesa para tu cita?'),
      line(false, 'hidratación'),
    ];
    expect(
      findRepeatedQuestion(
        '¿Cuál de estos horarios te queda mejor: mañana o el jueves?',
        dialogue,
      ),
    ).toBeNull();
    expect(
      findRepeatedQuestion('¿Algo más?', [
        line(true, '¿Algo más?'),
        line(false, 'no'),
      ]),
    ).toBeNull();
  });
});
