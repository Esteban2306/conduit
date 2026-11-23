export const AWAITING_TEAM_KEY = 'esperaRespuestaEquipo';
export const TEAM_ANSWER_KEY = 'respuestaEquipo';
export const AWAITING_TEAM_MAX_MS = 3 * 60 * 60 * 1000;
export const TEAM_ANSWER_TAKEOVER_MS = 15 * 1000;

export function awaitsTeamAnswer(
  context: Record<string, unknown>,
  now = Date.now(),
): boolean {
  const since = context[AWAITING_TEAM_KEY];
  if (typeof since !== 'string') return false;
  const at = new Date(since).getTime();
  return Number.isFinite(at) && now - at <= AWAITING_TEAM_MAX_MS;
}

const AMOUNT =
  /(?<![\d:/])(?<!\blas\s)\b\d{2,}(?:[.,]\d{3})*\b(?![:/]\d|\s*(?:h\b|horas?|min|a\.?\s?m|p\.?\s?m))/i;

export function answersWithAmount(text: string): boolean {
  return AMOUNT.test(text);
}

export function takeoverEndsAt(
  lastHuman: { createdAt: Date; answersPhoto: boolean },
  takeoverMs: number,
  now = Date.now(),
): Date | null {
  const end =
    lastHuman.createdAt.getTime() +
    (lastHuman.answersPhoto ? TEAM_ANSWER_TAKEOVER_MS : takeoverMs);
  return end > now ? new Date(end) : null;
}

export const TEAM_ANSWER_RESUME_MS = 60 * 60 * 1000;

export const TEAM_ANSWER_TURN =
  '[aviso del sistema: la persona del equipo acaba de responderle en este chat (es el último mensaje) y la clienta todavía no ha escrito nada nuevo. Sigue tú desde ahí, sin saludar ni repetir lo que dijo el equipo: si le dio un precio, guárdalo con la herramienta del precio del equipo si la tienes y continúa el paso en que iban (por ejemplo, confirma en una sola pregunta el servicio, el día, la hora y ese precio).]';

export function isHandoffPause(context: Record<string, unknown>): boolean {
  const reason = context.botPauseReason;
  return typeof reason === 'string' && reason.startsWith('Traspaso:');
}
