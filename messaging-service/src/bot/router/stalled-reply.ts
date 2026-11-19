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

export function isNoReply(reply: string): boolean {
  return reply.toUpperCase().includes(NO_REPLY_MARKER);
}
