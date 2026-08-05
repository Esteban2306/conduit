export function getNestedValue(
  obj: Record<string, any>,
  path: string,
): unknown {
  return path.split('.').reduce((current, segment) => {
    if (current === null || current === undefined) return undefined;
    return (current as Record<string, any>)[segment];
  }, obj as unknown);
}
