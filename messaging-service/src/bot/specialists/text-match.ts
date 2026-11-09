const LEGAL_SUFFIXES = new Set([
  'sas',
  'sa',
  'ltda',
  'srl',
  'sl',
  'inc',
  'llc',
  'ltd',
  'eu',
  'scs',
  'cia',
  'corp',
]);

const DOTTED_ACRONYM =
  /(?<![A-Za-z0-9])(?:[A-Za-z0-9]\.){2,}[A-Za-z0-9]?(?![A-Za-z0-9])/g;

export function normalizeText(value: string): string {
  return value
    .replace(DOTTED_ACRONYM, (match) => match.replace(/\./g, ''))
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokensOf(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .filter((token) => token.length > 1 || /\d/.test(token));
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function ratio(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - levenshtein(a, b) / longest;
}

function withoutLegalSuffix(tokens: string[]): string[] {
  const kept = tokens.filter((token) => !LEGAL_SUFFIXES.has(token));
  return kept.length > 0 ? kept : tokens;
}

export function fuzzySimilarity(a: string, b: string): number {
  const left = withoutLegalSuffix(tokensOf(a));
  const right = withoutLegalSuffix(tokensOf(b));
  if (left.length === 0 || right.length === 0) return 0;
  const inOrder = ratio(left.join(' '), right.join(' '));
  const sorted = ratio([...left].sort().join(' '), [...right].sort().join(' '));
  return Math.max(inOrder, sorted);
}

export function containsTokens(haystack: string, needle: string): boolean {
  const normalizedNeedle = normalizeText(needle);
  if (normalizedNeedle === '') return false;
  return ` ${normalizeText(haystack)} `.includes(` ${normalizedNeedle} `);
}
