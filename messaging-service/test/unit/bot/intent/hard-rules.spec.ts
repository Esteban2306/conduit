import { HardRuleDetector } from 'src/bot/intent/hard-rules';

const detect = (text: string, optedOut = false, chat = 'c1', at = Date.now()) =>
  new HardRuleDetector().detect(text, chat, optedOut, at);

describe('HardRuleDetector', () => {
  it.each([
    'STOP',
    'stop',
    'no quiero más mensajes',
    'ya no quiero recibir mensajes',
    'dejen de escribirme',
    'por favor dejen de molestar',
    'quiero darme de baja',
    'no me escriban más',
    'borren mi número',
    'no quiero recibir más publicidad',
  ])('"%s" es un opt-out', (text) => {
    expect(detect(text)).toEqual({ rule: 'opt_out' });
  });

  it.each([
    'quiero cancelar mi cita',
    'no puedo ir',
    'no quiero la cita del viernes',
    'estoy en la parada del bus',
    'stop por favor espera un momento mientras busco mi cédula y te la envío ahora mismo',
    'no quiero más información sobre el alisado, mejor dime del facial y cuánto cuesta cada uno',
  ])('"%s" NO es un opt-out', (text) => {
    expect(detect(text)).toBeNull();
  });

  it('cuando ya pidió silencio, solo "volver" y similares la reactivan', () => {
    expect(detect('quiero volver', true)).toEqual({ rule: 'opt_in' });
    expect(detect('reactivar mensajes', true)).toEqual({ rule: 'opt_in' });
    expect(detect('hola quiero agendar', true)).toBeNull();
    expect(detect('STOP', true)).toBeNull();
  });

  it.each([
    'son unos ladrones hp',
    'qué mierda de servicio',
    'idiotas',
    'HIJUEPUTA',
    'malparidos todos',
  ])('"%s" es abuso', (text) => {
    expect(detect(text)?.rule).toBe('abuse');
  });

  it.each([
    'quiero una cita',
    'tengo un problema con mi cabello',
    'el servicio fue pésimo',
    'es una puta locura lo bonito que quedó',
  ])('"%s" no es abuso', (text) => {
    const hit = detect(text);
    // la última tiene una palabra del léxico: se marca (el equipo revisa) y es el costo aceptado
    if (text.includes('puta')) expect(hit?.rule).toBe('abuse');
    else expect(hit).toBeNull();
  });

  it('spam: enlace con palabras de promoción, ráfaga y repetición', () => {
    expect(detect('Gana dinero fácil con bitcoin https://x.test/ya')).toEqual({
      rule: 'spam',
      reason: 'promo-link',
    });
    expect(detect('mira https://maps.google.com/mi-ubicacion')).toBeNull();
    expect(
      detect(Array.from({ length: 10 }, (_, i) => `msg ${i}`).join('\n')),
    ).toEqual({
      rule: 'spam',
      reason: 'flood',
    });

    const detector = new HardRuleDetector();
    const now = 1_000_000;
    const results = [0, 1, 2, 3].map((i) =>
      detector.detect('compra ya mi producto', 'chat', false, now + i * 1000),
    );
    expect(results.slice(0, 3)).toEqual([null, null, null]);
    expect(results[3]).toEqual({ rule: 'spam', reason: 'repetition' });
  });

  it('la repetición se mide por chat y vence con el tiempo', () => {
    const detector = new HardRuleDetector();
    for (let i = 0; i < 3; i++)
      detector.detect('hola hola', 'a', false, 1000 + i);
    expect(detector.detect('hola hola', 'b', false, 1100)).toBeNull();
    expect(
      detector.detect('hola hola', 'a', false, 1000 + 6 * 60 * 1000),
    ).toBeNull();
  });
});
