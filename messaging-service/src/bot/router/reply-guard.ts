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

const LIST_BLOCK_START = /^(?:\p{Extended_Pictographic}|\*|•)/u;

function joinListBlocks(paragraphs: string[]): string[] {
  const joined: string[] = [];
  let previousWasList = false;
  for (const paragraph of paragraphs) {
    const isList = LIST_BLOCK_START.test(paragraph);
    if (isList && previousWasList) {
      joined[joined.length - 1] += `\n\n${paragraph}`;
    } else {
      joined.push(paragraph);
    }
    previousWasList = isList;
  }
  return joined;
}

export function splitBubbles(
  text: string,
  maxBubbles: number = MAX_BUBBLES,
): string[] {
  const paragraphs = joinListBlocks(
    text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => !isBlank(p)),
  );
  if (paragraphs.length <= maxBubbles) return paragraphs;
  return [
    ...paragraphs.slice(0, maxBubbles - 1),
    paragraphs.slice(maxBubbles - 1).join('\n\n'),
  ];
}
