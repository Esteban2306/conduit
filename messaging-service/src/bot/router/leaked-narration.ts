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
  'Escribe solo el mensaje para la clienta, en español. No expliques lo que vas a hacer, lo que ves en los datos ni cómo calculaste una fecha o un precio.';

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

const GREETING_START =
  /^\s*[¡!]?\s*(?:hola|holi|buen(?:os|as)\s+(?:d[ií]as|tardes|noches))\b/i;

const PLANNING =
  /\b(?:hoy es (?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)\b.*\bas[ií] que|necesito saber|antes de (?:buscar|consultar|agendar|responder|ofrecer|guardar|saludar)|voy a (?:saludar|preguntar|consultar|buscar|responder|revisar|guardar|ofrecer|llamar|usar)|(?:debo|tengo que) (?:preguntar|consultar|ofrecer|guardar|llamar|usar|saludar)|la clienta|el cliente|la usuaria|el usuario|ya no aplicar[ií]a|no aplicar[ií]a)/i;

const ADDRESSES_CLIENT = /[¿?]|\b(?:te|tu|tus|ti|contigo|usted)\b/i;

export function looksLikePlanning(paragraph: string): boolean {
  return PLANNING.test(paragraph) && !ADDRESSES_CLIENT.test(paragraph);
}

export function withoutLeakedNarration(text: string): {
  content: string;
  dropped: number;
} {
  const paragraphs = text.split(/\n\s*\n/);
  const greetingAt = paragraphs.findIndex(
    (paragraph, index) => index > 0 && GREETING_START.test(paragraph),
  );
  const kept = paragraphs.filter(
    (paragraph, index) =>
      !(greetingAt > 0 && index < greetingAt) &&
      !looksEnglish(paragraph) &&
      !(paragraphs.length > 1 && looksLikePlanning(paragraph)),
  );
  return {
    content: kept.join('\n\n').trim(),
    dropped: paragraphs.length - kept.length,
  };
}
