export type Rng = () => number;

const between = (min: number, max: number, rng: Rng): number =>
  min + rng() * (max - min);

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const READ_DELAY_MIN_MS = 1_000;
export const READ_DELAY_MAX_MS = 4_000;
export const TYPING_MIN_MS = 1_200;
export const TYPING_MAX_MS = 5_000;
export const DEBOUNCE_JITTER = 0.25;

/** Cuánto tarda una persona en abrir el chat y leer: 1–4 s. */
export function readDelayMs(rng: Rng = Math.random): number {
  return Math.round(between(READ_DELAY_MIN_MS, READ_DELAY_MAX_MS, rng));
}

/**
 * Tiempo de "escribiendo": proporcional al largo (45–70 ms por carácter, con
 * un ritmo distinto en cada mensaje), nunca menos de 1,2 s ni más de 5 s para
 * no volver lenta la conversación.
 */
export function typingMs(textLength: number, rng: Rng = Math.random): number {
  const raw = Math.max(0, textLength) * between(45, 70, rng);
  return Math.round(
    clamp(raw, TYPING_MIN_MS, TYPING_MAX_MS) * between(0.9, 1.15, rng),
  );
}

/** Espera con variación ±`ratio` para que ninguna cadencia sea exacta. */
export function jittered(
  ms: number,
  ratio: number = DEBOUNCE_JITTER,
  rng: Rng = Math.random,
): number {
  return Math.round(ms * between(1 - ratio, 1 + ratio, rng));
}
