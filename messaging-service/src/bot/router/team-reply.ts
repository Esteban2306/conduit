export const AWAITING_TEAM_KEY = 'esperaRespuestaEquipo';
export const AWAITING_ADVICE_KEY = 'esperaConsejoEquipo';
export const TEAM_ANSWER_KEY = 'respuestaEquipo';
export const AWAITING_TEAM_MAX_MS = 3 * 60 * 60 * 1000;
export const TEAM_ANSWER_TAKEOVER_MS = 5 * 60 * 1000;
export const PHOTO_REQUESTED_KEY = 'fotoPedidaEn';
export const HAIR_PHOTO_NOTICE =
  'La clienta envió la foto de su cabello para que le digas el precio o qué le conviene. Búscala en el chat y respóndele por ahí: el bot espera tu respuesta (5 minutos después de tu último mensaje) y luego sigue con la cita con lo que le digas.';

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
  '[aviso del sistema: la persona del equipo acaba de responderle en este chat (es el último mensaje) y la clienta todavía no ha escrito nada nuevo. Sigue tú desde ahí, sin saludar ni repetir lo que dijo el equipo: si le recomendó un servicio o producto, preséntaselo y ofrécele agendarlo o pedirlo; si le dio un precio, guárdalo con la herramienta del precio del equipo si la tienes y continúa el paso en que iban (por ejemplo, confirma en una sola pregunta el servicio, el día, la hora y ese precio).]';

export function isHandoffPause(context: Record<string, unknown>): boolean {
  const reason = context.botPauseReason;
  return typeof reason === 'string' && reason.startsWith('Traspaso:');
}

export const TEAM_ANSWER_NOTE =
  'La persona del equipo ya le respondió en este chat (su último mensaje está en el historial). Tómalo como dato cierto: si es un precio, es el precio de su servicio; guárdalo con la herramienta del precio del equipo si la tienes, no lo cuestiones ni lo compares con el rango y sigue agendando con ese precio, sin pasar el chat a una persona por eso.';

const HAIR_PHOTO_REQUEST =
  /\b(?:envi[ae]|enviame|envianos|manda|mandame|mandanos|comparte|compartenos|compartime|adjunta)\b[^.?!\n]{0,80}\bfotos?\b[^.?!\n]{0,80}\b(?:cabello|pelo)\b/;

export function asksForHairPhoto(text: string): boolean {
  const plain = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return HAIR_PHOTO_REQUEST.test(plain);
}

export function photoRequestedRecently(
  context: Record<string, unknown>,
  now = Date.now(),
): boolean {
  const at = context[PHOTO_REQUESTED_KEY];
  if (typeof at !== 'string') return false;
  const time = new Date(at).getTime();
  return Number.isFinite(time) && now - time <= AWAITING_TEAM_MAX_MS;
}

export function asksToAwaitTeam(body: unknown): boolean {
  return (
    !!body &&
    typeof body === 'object' &&
    (body as Record<string, unknown>).awaitTeamAnswer === true &&
    (body as Record<string, unknown>).teamNotified !== false
  );
}
