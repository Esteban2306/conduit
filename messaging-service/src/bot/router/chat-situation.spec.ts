import { silenceNeedsCheck } from './chat-situation';

describe('en un chat traspasado, elegir una hora nunca se calla sin revisar', () => {
  it.each([
    'A las 7 está bien',
    'a las 10:30 am',
    'mejor el jueves',
    'esa hora me sirve',
  ])('%s', (text) => {
    expect(silenceNeedsCheck(true, null, text)).toBe(true);
  });

  it('un agradecimiento sí puede callarse', () => {
    expect(silenceNeedsCheck(true, null, 'muchas gracias')).toBe(false);
  });
});

import { looksLikeBusinessRequest } from './chat-situation';

describe('looksLikeBusinessRequest', () => {
  it.each([
    'Buenas, mi amiga quiere una terapia, la puedo agendar yo?',
    'quiero una cita para mi hija',
    'cuanto cuesta el alisado',
  ])('es del negocio: %s', (text) => {
    expect(looksLikeBusinessRequest(text)).toBe(true);
  });

  it.each([
    'hola mija como amaneciste hoy',
    'tia me puedes llevar a la hora del almuerzo',
    'mi hijo ya salio del colegio',
  ])('no es del negocio: %s', (text) => {
    expect(looksLikeBusinessRequest(text)).toBe(false);
  });
});
