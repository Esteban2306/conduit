import {
  jittered,
  readDelayMs,
  TYPING_MAX_MS,
  TYPING_MIN_MS,
  typingMs,
} from 'src/channels/whatsapp/baileys/human-timing';

describe('human-timing', () => {
  it('la lectura dura entre 1 y 4 s', () => {
    expect(readDelayMs(() => 0)).toBe(1_000);
    expect(readDelayMs(() => 0.999999)).toBeLessThanOrEqual(4_000);
    for (let i = 0; i < 200; i++) {
      const ms = readDelayMs();
      expect(ms).toBeGreaterThanOrEqual(1_000);
      expect(ms).toBeLessThanOrEqual(4_000);
    }
  });

  it('escribir es proporcional al largo, con mínimo y tope', () => {
    const mid = () => 0.5;
    const short = typingMs(10, mid);
    const medium = typingMs(60, mid);
    const long = typingMs(500, mid);
    expect(short).toBeGreaterThanOrEqual(TYPING_MIN_MS * 0.9);
    expect(medium).toBeGreaterThan(short);
    expect(long).toBeGreaterThan(medium);
    for (let i = 0; i < 200; i++) {
      expect(typingMs(5_000)).toBeLessThanOrEqual(TYPING_MAX_MS * 1.15);
    }
  });

  it('el mismo largo no produce siempre la misma duración', () => {
    const values = new Set(Array.from({ length: 30 }, () => typingMs(80)));
    expect(values.size).toBeGreaterThan(5);
  });

  it('jittered varía ±25 % y nunca cae a cero', () => {
    expect(jittered(8_000, 0.25, () => 0)).toBe(6_000);
    expect(jittered(8_000, 0.25, () => 1)).toBe(10_000);
    expect(jittered(0)).toBe(0);
  });
});
