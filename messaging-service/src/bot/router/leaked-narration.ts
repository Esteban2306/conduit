const ENGLISH_WORDS = new Set([
  'the',
  'and',
  'is',
  'it',
  "it's",
  'i',
  "i'll",
  "i'm",
  'which',
  'but',
  "doesn't",
  "don't",
  'yet',
  'now',
  'without',
  'until',
  'there',
  "there's",
  'she',
  "she's",
  'her',
  'how',
  'can',
  'what',
  'this',
  'that',
  'to',
  'of',
  'for',
  'with',
  'will',
  'know',
  'means',
  'refers',
  'let',
  'me',
  'should',
  'need',
  'first',
  'then',
  'so',
  'user',
  'tool',
  'call',
  'saving',
  'greet',
  'ask',
]);
const MIN_ENGLISH_WORDS = 4;
const MIN_ENGLISH_RATIO = 0.25;

export const SPANISH_ONLY_INSTRUCTION =
  'Escribe solo el mensaje para la clienta, en español. No expliques lo que vas a hacer ni lo que ves en los datos.';

export function looksEnglish(paragraph: string): boolean {
  const words = paragraph
    .toLowerCase()
    .replace(/[’]/g, "'")
    .split(/[^a-záéíóúñü']+/)
    .filter(Boolean);
  if (words.length === 0) return false;
  const hits = words.filter((word) => ENGLISH_WORDS.has(word)).length;
  return hits >= MIN_ENGLISH_WORDS && hits / words.length >= MIN_ENGLISH_RATIO;
}

export function withoutEnglishNarration(text: string): {
  content: string;
  dropped: number;
} {
  const paragraphs = text.split(/\n\s*\n/);
  const kept = paragraphs.filter((paragraph) => !looksEnglish(paragraph));
  return {
    content: kept.join('\n\n').trim(),
    dropped: paragraphs.length - kept.length,
  };
}
