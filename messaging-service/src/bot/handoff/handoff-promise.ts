import { normalizeText } from '../intent/normalize';

/**
 * Promesas de que una persona va a actuar ("se pondrá en contacto", "te
 * escribirá", "ya avisé al equipo"). Es una red de seguridad: lista estrecha
 * de formas futuras o consumadas. Las ofertas ("puedo pasarte con una
 * persona", "si quieres te paso con alguien") no cuentan.
 */
const PROMISES: RegExp[] = [
  /\bse pondra(?:n)? en contacto\b/,
  /\bnos pondremos en contacto\b/,
  /\bte (?:contactara|escribira|llamara|respondera|buscara|atendera)\b/,
  /\bte (?:van a|vamos a) (?:contactar|escribir|llamar|responder|atender)\b/,
  /\b(?:persona|asesor|asesora|alguien|equipo)(?: del| de nuestro| de| del spa)?(?: equipo| spa)? (?:te |se )?(?:contactara|escribira|comunicara|respondera|atendera|pondra en contacto|continuara)\b/,
  /\b(?:una persona|alguien|el equipo|un asesor|una asesora)\b.{0,60}\b(?:continuara|continuaran|te escribira|te contactara|te respondera)\b/,
  /\bya (?:avise|notifique|pase|le pase|le avise) (?:al equipo|a una persona|tu mensaje|tu caso|la conversacion)\b/,
  /\b(?:el equipo|una persona) (?:ya )?(?:fue|esta) (?:notificad[oa]|avisad[oa]|enterad[oa])\b/,
];

const OFFER_MARKERS =
  /\b(?:puedo|podria|quieres que|quieres|si prefieres|si deseas|si lo prefieres|te gustaria|prefieres que|te paso con|te puedo pasar|desea que)\b/;

export function promisesHumanContact(reply: string): boolean {
  return reply
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => normalizeText(sentence))
    .some(
      (sentence) =>
        sentence !== '' &&
        PROMISES.some((p) => p.test(sentence)) &&
        !OFFER_MARKERS.test(sentence),
    );
}
