export const MAX_TOOL_RESULT_CHARS = 6000;
const NOTICE_RESERVE = 120;
const MAX_DEPTH = 3;

export interface LimitedResult {
  data: unknown;
  chars: number;
  truncated: boolean;
}

function size(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

function fitArray(items: unknown[], budget: number): unknown[] {
  const kept: unknown[] = [];
  let used = 2;
  for (const item of items) {
    const next = size(item) + 1;
    if (used + next > budget) break;
    kept.push(item);
    used += next;
  }
  return kept;
}

function shrink(value: unknown, budget: number, depth: number): unknown {
  if (size(value) <= budget) return value;

  if (Array.isArray(value)) {
    const kept = fitArray(value, budget - NOTICE_RESERVE);
    return kept.length === value.length
      ? kept
      : [...kept, { omitidos: value.length - kept.length }];
  }

  if (value && typeof value === 'object' && depth < MAX_DEPTH) {
    const entries = Object.entries(value as Record<string, unknown>);
    const [largestKey] = entries.reduce(
      (best, entry) => (size(entry[1]) > size(best[1]) ? entry : best),
      entries[0],
    );
    const rest =
      size(value) - size((value as Record<string, unknown>)[largestKey]);
    const inner = shrink(
      (value as Record<string, unknown>)[largestKey],
      Math.max(budget - rest, NOTICE_RESERVE),
      depth + 1,
    );
    return { ...(value as object), [largestKey]: inner };
  }

  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `${text.slice(0, Math.max(budget - NOTICE_RESERVE, 0))}…`;
}

/**
 * Tope al resultado de una herramienta antes de dárselo al modelo. Las listas
 * se recortan por elementos (y se avisa cuántos faltan); un resultado normal
 * no se toca. Es una red de seguridad: lo que debe ser corto lo resuelve el
 * backend con respuestas magras.
 */
export function limitToolData(
  data: unknown,
  maxChars: number = MAX_TOOL_RESULT_CHARS,
): LimitedResult {
  const chars = size(data);
  if (chars <= maxChars) return { data, chars, truncated: false };
  const trimmed = shrink(data, maxChars, 0);
  return { data: trimmed, chars: size(trimmed), truncated: true };
}
