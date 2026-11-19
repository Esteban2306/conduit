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
