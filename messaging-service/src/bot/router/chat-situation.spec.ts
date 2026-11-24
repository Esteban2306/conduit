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
