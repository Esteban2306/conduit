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
