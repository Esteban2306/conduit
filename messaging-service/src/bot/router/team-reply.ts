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
