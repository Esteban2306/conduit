const INVISIBLE = /[​-‍⁠﻿ ]/g;
const MIN_KEPT_WHEN_CUTTING = 20;

export const MAX_BUBBLES = 3;

export function isBlank(text: string | null | undefined): boolean {
  return !text || text.replace(INVISIBLE, '').trim() === '';
}

export function cutAtSentence(text: string): string {
  const trimmed = text.trimEnd();
  if (
    /[.!?…)\]"»]$/.test(trimmed) ||
    /\p{Extended_Pictographic}$/u.test(trimmed)
  )
    return trimmed;

  let cut = -1;
  for (const match of trimmed.matchAll(/[.!?…](?=\s)|\n/g)) {
    const end = match.index + (match[0] === '\n' ? 0 : 1);
    if (end >= MIN_KEPT_WHEN_CUTTING) cut = end;
  }
  return cut === -1 ? trimmed : trimmed.slice(0, cut).trimEnd();
}

export function splitBubbles(
  text: string,
  maxBubbles: number = MAX_BUBBLES,
): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => !isBlank(p));
  if (paragraphs.length <= maxBubbles) return paragraphs;
  return [
    ...paragraphs.slice(0, maxBubbles - 1),
    paragraphs.slice(maxBubbles - 1).join('\n\n'),
  ];
}
