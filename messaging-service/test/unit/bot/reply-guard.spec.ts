import {
  cutAtSentence,
  isBlank,
  MAX_BUBBLES,
  splitBubbles,
} from 'src/bot/router/reply-guard';

describe('isBlank', () => {
  it.each(['', '   ', '\n\t ', '​', '​ ‍﻿', ' ', undefined, null])(
    '%j es vacío',
    (value) => {
      expect(isBlank(value as string | null | undefined)).toBe(true);
    },
  );

  it.each(['a', ' hola ', '👍', '.'])('%j no es vacío', (value) => {
    expect(isBlank(value)).toBe(false);
  });
});

describe('cutAtSentence', () => {
  it('no toca una respuesta que ya termina bien', () => {
    expect(cutAtSentence('Listo, quedó agendada.')).toBe(
      'Listo, quedó agendada.',
    );
    expect(cutAtSentence('¿Te sirve ese horario?')).toBe(
      '¿Te sirve ese horario?',
    );
    expect(cutAtSentence('Perfecto 😊')).toBe('Perfecto 😊');
  });

  it('corta en la última oración completa', () => {
    expect(
      cutAtSentence(
        'Hola, soy Sofía. Tenemos cupo el lunes. Para reservar necesito tu nom',
      ),
    ).toBe('Hola, soy Sofía. Tenemos cupo el lunes.');
  });

  it('corta en el último salto de línea si no hay punto', () => {
    expect(
      cutAtSentence(
        'Tenemos estos horarios\n- 8:00 a. m.\n- 9:00 a. m.\n- 10:',
      ),
    ).toBe('Tenemos estos horarios\n- 8:00 a. m.\n- 9:00 a. m.');
  });

  it('no deja un fragmento diminuto: si el único límite está muy al inicio conserva el texto', () => {
    expect(cutAtSentence('Hola. Quiero contarte que el trat')).toBe(
      'Hola. Quiero contarte que el trat',
    );
  });

  it('nunca devuelve vacío para un texto con contenido', () => {
    for (const text of [
      'Una frase muy larga sin punto que se corta aquí',
      'A. B',
      '...',
      'x',
    ]) {
      expect(isBlank(cutAtSentence(text))).toBe(false);
    }
  });
});

describe('splitBubbles', () => {
  it('un solo párrafo es una sola burbuja', () => {
    expect(splitBubbles('Hola, ¿cómo estás?')).toEqual(['Hola, ¿cómo estás?']);
  });

  it('divide por párrafo', () => {
    expect(splitBubbles('Primero.\n\nSegundo.')).toEqual([
      'Primero.',
      'Segundo.',
    ]);
  });

  it('una lista con bloques separados por línea en blanco viaja en una sola burbuja', () => {
    const intro = 'Estos son nuestros tratamientos';
    const list = [
      '✨ *Keratina*\n⏱ 90 min · 💰 $250.000',
      '✨ *Alisado*\n⏱ 120 min · 💰 $300.000',
      '✨ *Botox capilar*\n⏱ 60 min · 💰 $180.000',
    ].join('\n\n');
    const closing = '¿Te cuento más de alguno?';
    expect(splitBubbles(`${intro}\n\n${list}\n\n${closing}`)).toEqual([
      intro,
      list,
      closing,
    ]);
  });

  it('los títulos de categoría en negrita también se mantienen con su lista', () => {
    const list =
      '*Capilar*\n✨ *Keratina* · $250.000\n\n*Uñas*\n✨ *Semipermanente* · $60.000';
    expect(splitBubbles(`Mira:\n\n${list}\n\n¿Cuál te gusta?`)).toEqual([
      'Mira:',
      list,
      '¿Cuál te gusta?',
    ]);
  });

  it('párrafos normales siguen separándose', () => {
    expect(splitBubbles('Hola.\n\nTe cuento.\n\n¿Listo?')).toHaveLength(3);
  });

  it('nunca pasa del máximo: el resto se une en la última burbuja', () => {
    const text = ['a', 'b', 'c', 'd', 'e'].join('\n\n');
    const bubbles = splitBubbles(text);
    expect(bubbles).toHaveLength(MAX_BUBBLES);
    expect(bubbles[MAX_BUBBLES - 1]).toBe('c\n\nd\n\ne');
  });

  it('propiedad: ninguna burbuja queda vacía y no se pierde ningún carácter útil', () => {
    const pieces = [
      'hola',
      ' ',
      '\n',
      '\n\n',
      '​',
      'mundo 😊',
      '\t',
      'x.',
      '\n \n',
    ];
    let seed = 7;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < 500; i++) {
      const len = Math.floor(rand() * 12);
      const text = Array.from(
        { length: len },
        () => pieces[Math.floor(rand() * pieces.length)],
      ).join('');
      const bubbles = splitBubbles(text);
      expect(bubbles.length).toBeLessThanOrEqual(MAX_BUBBLES);
      expect(bubbles.every((b) => !isBlank(b))).toBe(true);
      const strip = (t: string) => t.replace(/[\s​]/g, '');
      expect(strip(bubbles.join(''))).toBe(strip(text));
      if (isBlank(text)) expect(bubbles).toEqual([]);
    }
  });
});
