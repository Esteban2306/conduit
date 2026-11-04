const ABBREVIATIONS: Record<string, string> = {
  q: 'que',
  xq: 'porque',
  pq: 'porque',
  x: 'por',
  xfa: 'por favor',
  pfa: 'por favor',
  porfa: 'por favor',
  plis: 'por favor',
  pls: 'por favor',
  tb: 'tambien',
  tmb: 'tambien',
  dnd: 'donde',
  cncl: 'cancelar',
};

/**
 * Minúsculas, sin tildes, emojis ni signos, letras repetidas colapsadas
 * ("holaaaa" → "hola") y abreviaturas comunes expandidas.
 */
export function normalizeText(raw: string): string {
  const base = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\p{Extended_Pictographic}|️|‍/gu, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/(.)\1{2,}/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return base
    .split(' ')
    .map((token) => ABBREVIATIONS[token] ?? token)
    .join(' ');
}

export function tokenCount(normalized: string): number {
  return normalized === '' ? 0 : normalized.split(' ').length;
}

const GREETING_TOKENS =
  /^(?:hola|holi|hey|buenas|buenos dias|buen dia|buenas tardes|buenas noches|saludos|que tal|como estas|como esta|que mas|amiga|amigo)(?: |$)/;

/**
 * Quita los saludos del inicio ("hola buenas tardes quiero cancelar" →
 * "quiero cancelar"). Devuelve null si no había saludo o no queda nada más.
 */
export function stripLeadingGreeting(normalized: string): string | null {
  let rest = normalized;
  let removed = false;
  for (let i = 0; i < 4; i++) {
    const match = GREETING_TOKENS.exec(rest);
    if (!match) break;
    rest = rest.slice(match[0].length).trim();
    removed = true;
  }
  return removed && rest !== '' ? rest : null;
}

const AFFIRMATION_CORE = new Set([
  'si',
  'sii',
  'dale',
  'listo',
  'claro',
  'ok',
  'okay',
  'okey',
  'vale',
  'perfecto',
  'confirmo',
  'confirmala',
  'confirmalo',
  'reservala',
  'agendala',
  'hazlo',
  'adelante',
  'correcto',
  'exacto',
]);

const AFFIRMATION_FILLER = new Set([
  'de',
  'una',
  'por',
  'favor',
  'gracias',
  'asi',
  'esta',
  'bien',
  'muy',
  'bueno',
  'supuesto',
  'que',
  'quede',
]);

/** "sí", "sí, confírmala", "dale, listo": una confirmación corta y sin condiciones. */
export function isAffirmation(raw: string): boolean {
  const normalized = normalizeText(raw);
  const tokens = normalized === '' ? [] : normalized.split(' ');
  if (tokens.length === 0 || tokens.length > 6) return false;
  return (
    tokens.some((t) => AFFIRMATION_CORE.has(t)) &&
    tokens.every((t) => AFFIRMATION_CORE.has(t) || AFFIRMATION_FILLER.has(t))
  );
}
