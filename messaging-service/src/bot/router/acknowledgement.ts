/**
 * Respuestas cortas que, sin una pregunta abierta del bot, solo acusan
 * recibo ("ok", "listo"). Si el bot acaba de preguntar algo
 * ("¿Confirmas la cita?"), son la respuesta y hay que procesarlas.
 */
const SHORT_ANSWERS =
  /^(ok|okay|okey|vale|s[ií]|no|ya|dale|listo|claro|perfecto|de una|bueno|👍|👌)[.!]*$/i;

/** Cortesías de cierre: nunca piden una respuesta del bot. */
const COURTESIES =
  /^(gracias|muchas gracias|mil gracias|ok gracias|thanks|ty|bye|adi[oó]s|ciao|chao|hasta luego|np|de nada|con gusto|🙏|❤️|😊|👋)[.!]*$/i;

function botAskedSomething(lastBotMessage: string | null): boolean {
  if (!lastBotMessage) return false;
  return lastBotMessage.includes('?');
}

/**
 * Decide si un mensaje del cliente puede ignorarse sin responder.
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

  const normalized = text.trim().toLowerCase();
  const asked = !taskDone && botAskedSomething(lastBotMessage);
  if (COURTESIES.test(normalized)) return !asked;
  if (SHORT_ANSWERS.test(normalized)) return !asked;
  return false;
}
