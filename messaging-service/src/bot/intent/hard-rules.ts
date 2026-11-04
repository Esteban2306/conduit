import { normalizeText, tokenCount } from './normalize';

export type HardRuleHit =
  | { rule: 'opt_out' }
  | { rule: 'opt_in' }
  | { rule: 'abuse'; words: string[] }
  | { rule: 'spam'; reason: 'promo-link' | 'repetition' | 'flood' };

const OPT_OUT: RegExp[] = [
  /^(?:stop|baja|salir|unsubscribe|desuscribir|desuscribirme|desuscribirse)$/,
  /\b(?:no|ya no) (?:quiero|deseo|necesito) (?:recibir )?(?:mas )?(?:mensajes|publicidad|promociones|informacion|notificaciones)\b/,
  /\b(?:dejen|deja|dejar|dejenme|paren|pare|parar) de (?:escribir|enviar|mandar|molestar|contactar)(?:me|nos)?\b/,
  /\b(?:darme|dame|darnos|denme) de baja\b/,
  /\bno me (?:escriban|escribas|molesten|molestes|contacten|contactes|envien|envies|manden|mandes) mas\b/,
  /\b(?:borren|eliminen|quiten|borra|elimina|quita) mi (?:numero|contacto)\b/,
];
const OPT_OUT_MAX_TOKENS = 12;

const OPT_IN: RegExp[] = [
  /^(?:quiero |deseo |quisiera )?(?:volver a recibir|reactivar|retomar|volver a escribir|volver)(?: los| las| mis)?(?: mensajes| informacion| notificaciones)?$/,
  /^(?:activar|reactivar|suscribirme|suscribir)(?: los| las| mis)?(?: mensajes| notificaciones| el bot)?$/,
];

const INSULTS = new Set([
  'hp',
  'hdp',
  'hijueputa',
  'hijueputas',
  'hijoeputa',
  'hijodeputa',
  'malparido',
  'malparida',
  'malparidos',
  'gonorrea',
  'puta',
  'puto',
  'mierda',
  'imbecil',
  'imbeciles',
  'idiota',
  'idiotas',
  'estupido',
  'estupida',
  'maldito',
  'maldita',
  'basura',
  'asquerosos',
  'sinverguenza',
  'sinverguenzas',
]);

const PROMO_WORDS =
  /\b(?:gana|ganar|ganancias|dinero facil|inversion|invierte|bitcoin|cripto|casino|apuestas?|prestamos?|credito aprobado|trabaja desde casa|oferta exclusiva|haz clic|click aqui|suscribete|sorteo|premio)\b/;
const LINK = /https?:\/\/|www\.|bit\.ly|t\.me|wa\.me|\.com\b/;

const REPEAT_WINDOW_MS = 5 * 60 * 1000;
const REPEAT_LIMIT = 4;
const FLOOD_LINES = 10;
const MAX_TRACKED_CHATS = 5000;

/**
 * Reglas duras de 0 tokens: opt-out, abuso y spam. La detección es del
 * motor (es independiente del negocio); los textos y el modo de cada una se
 * configuran por bot con las claves reservadas `rule.*`.
 */
export class HardRuleDetector {
  private readonly recent = new Map<
    string,
    Array<{ text: string; at: number }>
  >();

  detect(
    text: string,
    chat: string,
    optedOut: boolean,
    now: number = Date.now(),
  ): HardRuleHit | null {
    const raw = text.trim();
    if (raw === '') return null;

    if (raw.split('\n').filter((l) => l.trim() !== '').length >= FLOOD_LINES) {
      return { rule: 'spam', reason: 'flood' };
    }

    const normalized = normalizeText(raw);
    if (normalized === '') return null;
    const tokens = tokenCount(normalized);

    if (optedOut) {
      if (OPT_IN.some((p) => p.test(normalized))) return { rule: 'opt_in' };
      return null;
    }

    if (
      tokens <= OPT_OUT_MAX_TOKENS &&
      OPT_OUT.some((p) => p.test(normalized))
    ) {
      return { rule: 'opt_out' };
    }

    if (PROMO_WORDS.test(normalized) && LINK.test(raw.toLowerCase())) {
      return { rule: 'spam', reason: 'promo-link' };
    }

    if (this.isRepeated(chat, normalized, now)) {
      return { rule: 'spam', reason: 'repetition' };
    }

    const words = normalized.split(' ').filter((t) => INSULTS.has(t));
    if (words.length > 0) return { rule: 'abuse', words };

    return null;
  }

  private isRepeated(chat: string, normalized: string, now: number): boolean {
    if (normalized.length < 4) return false;
    const entries = (this.recent.get(chat) ?? []).filter(
      (e) => now - e.at < REPEAT_WINDOW_MS,
    );
    entries.push({ text: normalized, at: now });
    this.recent.set(chat, entries);
    if (this.recent.size > MAX_TRACKED_CHATS) this.prune(now);
    return entries.filter((e) => e.text === normalized).length >= REPEAT_LIMIT;
  }

  private prune(now: number): void {
    for (const [chat, entries] of this.recent) {
      if (entries.every((e) => now - e.at >= REPEAT_WINDOW_MS)) {
        this.recent.delete(chat);
      }
    }
  }
}

export const DEFAULT_RULE_TEXTS = {
  opt_out: [
    'Listo, no te volveremos a escribir por este medio. Si más adelante quieres retomar la conversación, escríbenos "volver" y con gusto te atendemos. 🌿',
  ],
  opt_in: [
    '¡Qué gusto tenerte de vuelta! 😊 Ya puedes escribirnos cuando quieras y te atendemos por aquí.',
  ],
  abuse: [
    'Entiendo que algo no salió bien y lamento que te sientas así. Prefiero que una persona del equipo te atienda directamente; ya le pasé tu mensaje y te escribirá por este chat.',
  ],
  spam: [] as string[],
};
