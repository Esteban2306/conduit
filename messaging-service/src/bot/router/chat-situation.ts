import { ConversationContext } from '../conversation/interfaces/ConversationContext';
import { HANDOFF_REASON_KEY } from '../handoff/handoff-defaults';
import { normalizeText } from '../intent/normalize';
import { NO_REPLY_MARKER } from './stalled-reply';

export const PERSONAL_CHAT_AT_KEY = 'personalChatAt';
export const PERSONAL_CHAT_TEXT_KEY = 'personalChatText';

const PERSONAL_CHAT_WINDOW_MS = 12 * 60 * 60 * 1000;
const PERSONAL_TEXT_MAX = 200;

const MAX_FIRST_CONTACT_NOTICE = 300;

export function firstContactNoticeOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const notice = (body as Record<string, unknown>).firstContactNotice;
  return typeof notice === 'string' && notice.trim() !== ''
    ? notice.trim().slice(0, MAX_FIRST_CONTACT_NOTICE)
    : null;
}

export function handoffQuietNote(context: ConversationContext): string {
  const reason = context[HANDOFF_REASON_KEY];
  const motive =
    typeof reason === 'string' && reason.trim() !== ''
      ? ` (motivo: ${reason.trim().slice(0, 200)})`
      : '';
  return `Este chat ya se pasó al equipo${motive} y una persona lo atenderá. Si pregunta por citas, horarios, cupos, precios, servicios o productos (por ejemplo "otra cosa, ¿tienes cupo el viernes?"), respóndele con normalidad y con las herramientas, como a cualquier clienta: eso nunca se calla. A todo lo demás (agradecimientos, despedidas o el tema que se pasó al equipo) responde solo ${NO_REPLY_MARKER}. No vuelvas a pasar el chat ni repitas que una persona escribirá.`;
}

export function personalChatPatch(
  pendingText: string,
  now = new Date(),
): Record<string, string> {
  return {
    [PERSONAL_CHAT_AT_KEY]: now.toISOString(),
    [PERSONAL_CHAT_TEXT_KEY]: pendingText.trim().slice(0, PERSONAL_TEXT_MAX),
  };
}

export function personalChatNote(
  context: ConversationContext,
  now = Date.now(),
): string | null {
  const at = context[PERSONAL_CHAT_AT_KEY];
  const text = context[PERSONAL_CHAT_TEXT_KEY];
  if (typeof at !== 'string' || typeof text !== 'string' || text === '') {
    return null;
  }
  const elapsed = now - new Date(at).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  if (elapsed > PERSONAL_CHAT_WINDOW_MS) return null;
  return `Hace poco no respondiste un mensaje de esta persona porque era personal y no del negocio: «${text}». Si lo nuevo sigue esa charla personal, responde solo ${NO_REPLY_MARKER}; si pregunta por el negocio, atiéndela.`;
}

const BUSINESS_WORDS =
  /\b(?:cita|citas|cupo|cupos|horario|horarios|disponib\w*|agend\w*|reserv\w*|apart\w*|precio|precios|valor|cuanto|costo|cuesta|servicio|servicios|tratamiento\w*|producto\w*|promoci\w*|reagend\w*|cancel\w*|hoy|manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|semana)\b/;

export function silenceNeedsCheck(
  handoffQuiet: boolean,
  personalNote: string | null,
  text: string,
): boolean {
  if (handoffQuiet) return BUSINESS_WORDS.test(normalizeText(text));
  return personalNote === null;
}
