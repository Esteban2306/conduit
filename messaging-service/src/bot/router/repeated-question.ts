import { normalizeText } from '../intent/normalize';

export interface DialogueLine {
  fromBot: boolean;
  content: string;
}

export interface RepeatedQuestion {
  previous: string;
  answer: string;
}

const STOPWORDS = new Set([
  'para',
  'quieres',
  'quiere',
  'puedes',
  'puede',
  'tienes',
  'tiene',
  'gustaria',
  'deseas',
  'desea',
  'prefieres',
  'prefiere',
  'algun',
  'alguna',
  'algo',
  'esta',
  'este',
  'esto',
  'como',
  'cual',
  'cuales',
  'donde',
  'cuando',
  'porfa',
  'favor',
  'ahora',
]);
const MIN_QUESTION_WORDS = 3;
const SIMILARITY = 0.6;
const LOOKBACK_BOT_MESSAGES = 6;

export function questionsOf(text: string): string[] {
  const found: string[] = text.match(/¿?[^.!?¿\n]+\?/g) ?? [];
  return found.map((question) => question.trim());
}

function wordsOf(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .split(' ')
      .filter((word) => word.length >= 4 && !STOPWORDS.has(word)),
  );
}

function similarity(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

export function findRepeatedQuestion(
  reply: string,
  dialogue: DialogueLine[],
): RepeatedQuestion | null {
  const asked = questionsOf(reply)
    .map((question) => wordsOf(question))
    .filter((words) => words.size >= MIN_QUESTION_WORDS);
  if (asked.length === 0) return null;

  let botSeen = 0;
  for (let i = dialogue.length - 1; i >= 0; i--) {
    const line = dialogue[i];
    if (!line.fromBot) continue;
    botSeen += 1;
    if (botSeen > LOOKBACK_BOT_MESSAGES) break;
    const answer = dialogue
      .slice(i + 1)
      .find((next) => !next.fromBot && next.content.trim() !== '');
    if (!answer) continue;
    for (const previous of questionsOf(line.content)) {
      const words = wordsOf(previous);
      if (words.size < MIN_QUESTION_WORDS) continue;
      if (asked.some((current) => similarity(current, words) >= SIMILARITY)) {
        return { previous, answer: answer.content.trim() };
      }
    }
  }
  return null;
}
