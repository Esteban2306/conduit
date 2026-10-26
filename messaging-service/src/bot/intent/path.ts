const hasOwn = (target: object, key: string) =>
  Object.prototype.hasOwnProperty.call(target, key);

/**
 * Lee un valor con una ruta mínima: `a.b`, `a[0]`, `a[*]` (aplana listas).
 * Con `[*]` el resultado siempre es una lista. No recorre el prototipo.
 */
export function getPath(data: unknown, path: string): unknown {
  const clean = path.replace(/^\$\.?/, '');
  if (clean === '') return data;
  const tokens: string[] = clean.match(/\[\*\]|\[\d+\]|[^.[\]]+/g) ?? [];

  const multi = tokens.includes('[*]');
  let current: unknown[] = [data];
  for (const token of tokens) {
    const next: unknown[] = [];
    if (token === '[*]') {
      for (const value of current) {
        if (Array.isArray(value)) next.push(...value);
      }
    } else if (token.startsWith('[')) {
      const index = Number(token.slice(1, -1));
      for (const value of current) {
        if (Array.isArray(value) && index < value.length) {
          next.push(value[index]);
        }
      }
    } else {
      for (const value of current) {
        if (
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          hasOwn(value, token)
        ) {
          next.push((value as Record<string, unknown>)[token]);
        }
      }
    }
    current = next;
    if (current.length === 0) return multi ? [] : undefined;
  }
  return multi ? current : current[0];
}

export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}
