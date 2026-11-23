export const GREETED_WINDOW_MS = 12 * 60 * 60 * 1000;

export const ALREADY_GREETED_NOTE =
  'Ya saludaste a esta persona hace un rato en este chat: no la saludes ni te presentes otra vez; responde directo a lo que pide.';

const GREETING =
  /^\s*[¡!]?\s*(?:hola|holi|buen(?:os|as)\s+(?:d[ií]as|tardes|noches))(?![\p{L}])/iu;
const AGAIN = /^\s*de nuevo(?![\p{L}])/iu;
const NAME =
  /^\s*,?\s*(?!soy(?![\p{L}]))\p{Lu}\p{L}*(?:\s+\p{Lu}\p{L}*)?(?![\p{L}])/u;
const INTRODUCTION =
  /^\s*,?\s*soy\s+[^\n.!?¿]*?(?:[.!]+|(?=\n)|(?=\s*\p{Extended_Pictographic})|$)/iu;
const FILLER = /^(?:[\s,.!¡]|\p{Extended_Pictographic}|\u{FE0F}|\u{200D})+/u;

function strip(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  return match ? text.slice(match[0].length) : null;
}

export function withoutRepeatedGreeting(reply: string): string {
  let rest = reply;
  let greeted = false;
  for (let round = 0; round < 3; round++) {
    const afterGreeting = strip(rest, GREETING);
    if (afterGreeting !== null) {
      greeted = true;
      rest = afterGreeting;
      rest = strip(rest, AGAIN) ?? rest;
      rest = strip(rest, NAME) ?? rest;
      rest = strip(rest, FILLER) ?? rest;
      continue;
    }
    const afterIntro = greeted ? strip(rest, INTRODUCTION) : null;
    if (afterIntro === null) break;
    rest = strip(afterIntro, FILLER) ?? afterIntro;
  }
  if (!greeted) return reply;
  const trimmed = rest.trim();
  if (trimmed === '') return reply;
  return trimmed.charAt(0).toLocaleUpperCase('es') + trimmed.slice(1);
}
