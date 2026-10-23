export interface ExecutedToolCall {
  name: string;
  ok: boolean;
}

export function hasUnrecoveredToolFailure(
  calls: ExecutedToolCall[] | undefined,
): boolean {
  if (!calls?.length) return false;
  const lastOutcome = new Map<string, boolean>();
  for (const call of calls) lastOutcome.set(call.name, call.ok);
  return [...lastOutcome.values()].some((ok) => !ok);
}
