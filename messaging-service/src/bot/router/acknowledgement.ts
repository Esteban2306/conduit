import { normalizeText } from '../intent/normalize';

/**
 * Palabras que, solas o combinadas entre sí, solo acusan recibo o se
 * despiden: "ok", "listo gracias", "súper", "mil gracias", "de una". Ya vienen
 * normalizadas (minúsculas, sin tildes, letras repetidas colapsadas), así que
 * "graciaaas", "Oki" o "SÚPER!!" coinciden sin listarlas una por una.
 *
 * Cada mensaje necesita al menos una palabra del núcleo; las de relleno solo
 * acompañan. Si aparece cualquier otra palabra, un número o una pregunta, el
 * mensaje se procesa: ignorar por error una respuesta real es peor que gastar
 * una respuesta de más.
 */
const ACK_CORE = new Set([
  'ok',
  'okay',
  'okey',
  'oki',
  'okis',
  'oka',
  'vale',
  'si',
  'sii',
  'no',
  'ya',
  'dale',
  'listo',
  'lista',
  'claro',
  'perfecto',
  'perfecta',
  'bueno',
  'buena',
  'buenisimo',
  'genial',
  'super',
  'excelente',
  'entendido',
  'chevere',
  'bien',
  'gracias',
  'thanks',
  'ty',
  'bye',
  'adios',
  'ciao',
  'chao',
  'hasta',
  'np',
  'nada',
  'gusto',
]);

const ACK_FILLER = new Set([
  'de',
  'mil',
  'muchas',
  'muy',
  'luego',
  'con',
  'thank',
  'you',
]);

/** Emojis de cortesía: "👍", "🙏", "❤️". Cualquier otro emoji cuenta como contenido. */
const ACK_EMOJIS = new Set([
  '👍',
  '👌',
  '🙏',
  '❤',
  '😊',
  '👋',
  '🙌',
  '😉',
  '👏',
  '✅',
  '🙂',
  '😁',
  '🥰',
  '😘',
  '💖',
  '💕',
]);

const MAX_ACK_WORDS = 5;

/** "okeyy" y "okey" son la misma palabra: se comparan sin letras repetidas. */
const squash = (word: string) => word.replace(/(.)\1+/g, '$1');
const CORE = new Set([...ACK_CORE].map(squash));
const FILLER = new Set([...ACK_FILLER].map(squash));

export function acknowledgesOnly(text: string): boolean {
  if (/[?¿]/.test(text)) return false;

  const emojis = text.match(/\p{Extended_Pictographic}/gu) ?? [];
  if (emojis.some((emoji) => !ACK_EMOJIS.has(emoji))) return false;

  const normalized = normalizeText(text).replace(/\bde una\b/g, 'dale');
  const words = (normalized === '' ? [] : normalized.split(' ')).map(squash);
  if (words.length === 0 && emojis.length === 0) return false;
  if (words.length > MAX_ACK_WORDS) return false;
  if (words.some((w) => !CORE.has(w) && !FILLER.has(w))) return false;
  if (words.length > 0 && !words.some((w) => CORE.has(w))) return false;

  // "si no…" no es un acuse: suele ser el inicio de una condición.
  const polarity = words.filter((w) => w === 'si' || w === 'sii' || w === 'no');
  return !(polarity.length > 1 && new Set(polarity).size > 1);
}

/** El bot dejó algo abierto: cualquier "?" o "¿" en su último mensaje. */
function botAskedSomething(lastBotMessage: string | null): boolean {
  return !!lastBotMessage && /[?¿]/.test(lastBotMessage);
}

/**
 * Decide si un mensaje del cliente puede ignorarse sin responder. Sin una
 * pregunta abierta del bot, "ok" o "gracias" no piden nada. Si el bot acaba
 * de preguntar algo ("¿Confirmas la cita?"), son la respuesta y hay que
 * procesarlas.
 *
 * @param lastBotMessage último mensaje que el negocio le envió al cliente
 * @param hasPendingBatch el cliente ya tiene mensajes acumulados sin
 *        responder; en ese caso el mensaje corto se suma al lote
 * @param taskDone el agendamiento acaba de terminar: ninguna pregunta del
 *        bot sigue abierta, así que el relleno se ignora siempre
 */
export function isIgnorableAcknowledgement(
  text: string,
  lastBotMessage: string | null,
  hasPendingBatch = false,
  taskDone = false,
): boolean {
  if (hasPendingBatch) return false;
  if (!acknowledgesOnly(text)) return false;
  return taskDone || !botAskedSomething(lastBotMessage);
}
