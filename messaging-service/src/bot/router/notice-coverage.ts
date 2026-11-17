import { normalizeText } from '../intent/normalize';

const KEY_TOKEN = /https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s-]{5,}\d/g;
const MIN_WORD_LENGTH = 5;
const WORD_COVERAGE = 0.7;
const PHONE_TAIL_DIGITS = 10;
const GREETING_BUBBLE = /^(?:hola|buen[oa]s|qu[eé] gusto)/i;
const GREETING_MAX_CHARS = 160;

function keyTokensOf(text: string): string[] {
  const tokens: string[] = text.match(KEY_TOKEN) ?? [];
  return tokens.map((token) => {
    const digits = token.replace(/\D/g, '');
    return /^\+?\d[\d\s-]+$/.test(token)
      ? digits.slice(-PHONE_TAIL_DIGITS)
      : token.toLowerCase();
  });
}

function wordsOf(text: string): string[] {
  return normalizeText(text)
    .split(' ')
    .filter((word) => word.length >= MIN_WORD_LENGTH);
}

export function coversNotice(reply: string, notice: string): boolean {
  const keys = keyTokensOf(notice);
  if (keys.length > 0) {
    const digits = reply.replace(/\D/g, '');
    const lower = reply.toLowerCase();
    return keys.every((key) =>
      /^\d+$/.test(key) ? digits.includes(key) : lower.includes(key),
    );
  }
  const words = wordsOf(notice);
  if (words.length === 0) return true;
  const present = new Set(wordsOf(reply));
  return (
    words.filter((word) => present.has(word)).length / words.length >=
    WORD_COVERAGE
  );
}

export function withNotices(reply: string, notices: string[]): string {
  const missing = notices.filter((notice) => !coversNotice(reply, notice));
  if (missing.length === 0) return reply;
  const block = missing.join('\n\n');
  const parts = reply.trim().split(/\n{2,}/);
  const first = parts[0]?.trim() ?? '';
  if (
    parts.length > 1 &&
    GREETING_BUBBLE.test(first) &&
    first.length <= GREETING_MAX_CHARS
  ) {
    return [first, block, ...parts.slice(1)].join('\n\n');
  }
  return reply.trim() === '' ? block : `${block}\n\n${reply.trim()}`;
}
