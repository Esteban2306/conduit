import { normalizeText } from '../intent/normalize';

const PENDING_CHECK = [
  /\b(?:dejame|permiteme|dame un momento|un momento|un momentico|ya mismo|enseguida|en seguida)\b.{0,40}\b(?:revis|consult|mir|busc|verific|confirm)/,
  /\b(?:voy a|vamos a|ya voy a|te voy a|procedo a)\s+(?:revis|consult|mirar|buscar|verific|confirmar|dar|enviar|compartir)/,
  /\b(?:reviso|consulto|verifico|busco|miro)\b.{0,30}\b(?:y te|ya te|enseguida|ahora|un momento)\b/,
  /\bte (?:doy|confirmo|paso|comparto|envio|cuento)\b.{0,40}\b(?:ahora mismo|ya mismo|enseguida|en un momento|en seguida)\b/,
  /\bnecesito (?:revisar|consultar|verificar|mirar|buscar)\b/,
];

export function announcesPendingCheck(reply: string): boolean {
  const text = normalizeText(reply);
  return PENDING_CHECK.some((pattern) => pattern.test(text));
}

export const STALLED_REPLY_INSTRUCTION =
  'ATENCIÓN: en tu intento anterior le dijiste a la clienta que ibas a revisar o a darle un dato, pero no llamaste ninguna herramienta, así que ella se queda esperando una respuesta que nunca llega. Llama ahora las herramientas que hagan falta (por ejemplo listar_tratamientos, disponibilidad_combo, consultar_disponibilidad, reservas_proximas o info_negocio) y respóndele en este mismo mensaje con los datos reales. No anuncies que vas a revisar.';

export const NO_REPLY_MARKER = '[NO_RESPONDER]';

export const NO_REPLY_CONFIRM_INSTRUCTION = `REVISA ANTES DE CALLAR: aplica de nuevo las reglas del prompt sobre cuándo no responder. Si según ellas es evidente que el mensaje no es para el negocio, responde otra vez solo ${NO_REPLY_MARKER}. Si puede ser de una clienta, respóndele normalmente.`;

export const QUIET_NO_REPLY_CONFIRM_INSTRUCTION = `REVISA ANTES DE CALLAR: ¿el mensaje pregunta por citas, horarios, cupos, precios, servicios o productos? Si sí, respóndele normalmente con las herramientas. Si no (saludos, "¿sigue ahí?", agradecimientos o el tema que ya se pasó al equipo), responde otra vez solo ${NO_REPLY_MARKER}.`;

export function isNoReply(reply: string): boolean {
  return reply.toUpperCase().includes(NO_REPLY_MARKER);
}

const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const INTERNAL_WORDS =
  /\b(?:ids?|uuid|json|endpoint|backend|api|herramientas?|base de datos|mi sistema|el prompt)\b/i;

const mentionsTool = (text: string, toolNames: readonly string[]) => {
  const lower = text.toLowerCase();
  return toolNames.some(
    (name) => name.includes('_') && lower.includes(name.toLowerCase()),
  );
};

export function leaksInternals(
  reply: string,
  toolNames: readonly string[],
): boolean {
  return (
    UUID.test(reply) ||
    INTERNAL_WORDS.test(reply) ||
    mentionsTool(reply, toolNames)
  );
}

export function scrubInternals(
  reply: string,
  toolNames: readonly string[],
): string {
  return reply
    .split(/\n/)
    .map((line) =>
      line
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => !leaksInternals(sentence, toolNames))
        .join(' '),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const TECHNICAL_LEAK_INSTRUCTION =
  'ATENCIÓN: tu respuesta anterior le mostraba a la clienta detalles internos (ids, nombres de herramientas, "el sistema", JSON o cómo funcionas por dentro). Escríbele de nuevo lo mismo en lenguaje sencillo y cálido, como una persona del equipo, sin ninguno de esos detalles. No vuelvas a ejecutar acciones que ya hiciste.';

const ASKS_DAY = [
  /\b(?:que|cual|para que) dia\b.{0,30}\b(?:te (?:gustaria|queda|sirve|conviene|parece|funciona)|prefieres|quieres|seria|puedes)\b/,
  /\bsi me (?:dices|cuentas|indicas) (?:que|el|cual) dia\b/,
  /\b(?:que|cual) dia (?:te|le|seria|prefieres)\b/,
  /\b(?:te|le) (?:busco|reviso|consulto|muestro|paso|comparto) (?:los |unos |las )?(?:cupos|horarios|espacios|citas disponibles)\b/,
  /\bquieres que (?:te )?(?:busque|revise|consulte|mire) (?:los |unos )?(?:cupos|horarios|espacios)\b/,
];

export function asksForDay(reply: string): boolean {
  const text = normalizeText(reply);
  return ASKS_DAY.some((pattern) => pattern.test(text));
}

export const askedDayInstruction = (slotTools: readonly string[]) =>
  `ATENCIÓN: le preguntaste a la clienta qué día quiere o si le buscas los cupos. No le preguntes nada de eso: si ya sabes qué servicio quiere, llama ahora ${slotTools.join(' o ')} desde hoy y ofrécele en este mismo mensaje los 2 o 3 cupos más cercanos, recomendando el primero. Si aún no sabes el servicio, pregúntale solo eso.`;

const DENIES_OFFER = [
  /\bno (?:tenemos|ofrecemos|manejamos|contamos con|vendemos|hacemos|trabajamos)\b/,
  /\bno (?:encuentro|veo|aparece|existe)\b.{0,40}\b(?:servicio|tratamiento|terapia|producto|catalogo|cupo|cupos|horario)/,
  /\bno hay (?:cupo|cupos|disponibilidad|horario|horarios)\b/,
];

export function deniesOffer(reply: string): boolean {
  const text = normalizeText(reply);
  return DENIES_OFFER.some((pattern) => pattern.test(text));
}

export const uncheckedDenialInstruction = (readTools: readonly string[]) =>
  `ATENCIÓN: le dijiste a la clienta que algo no lo tenemos o no hay, pero en este turno no revisaste nada. Llama ahora la herramienta de consulta que corresponda${readTools.length ? ` (${readTools.join(', ')})` : ''} y respóndele según lo que de verdad exista. Nunca digas que algo no existe sin haberlo revisado.`;
