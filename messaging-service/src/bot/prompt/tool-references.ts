const TOOL_LIKE_NAME = /\b[a-z]+(?:_[a-z]+)+\b/g;

export function findUnknownToolReferences(
  content: string,
  toolNames: readonly string[],
): string[] {
  const known = new Set(toolNames);
  const mentioned = content.match(TOOL_LIKE_NAME) ?? [];
  return [...new Set(mentioned)].filter((name) => !known.has(name));
}
