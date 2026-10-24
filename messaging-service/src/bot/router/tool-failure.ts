export interface ExecutedToolCall {
  name: string;
  ok: boolean;
}

export function hasUnrecoveredToolFailure(
  calls: ExecutedToolCall[] | undefined,
  readOnlyTools: ReadonlySet<string> = new Set(),
): boolean {
  if (!calls?.length) return false;
  const lastIndex = new Map<string, number>();
  calls.forEach((call, i) => lastIndex.set(call.name, i));

  return [...lastIndex.entries()].some(([name, index]) => {
    if (calls[index].ok) return false;
    if (!readOnlyTools.has(name)) return true;
    return !calls
      .slice(index + 1)
      .some((later) => later.ok && readOnlyTools.has(later.name));
  });
}
