/**
 * Rutas con punto ("client.phone") sobre parámetros de herramientas y sus
 * JSON Schema. Permite que Conduit inyecte datos verificados (el teléfono
 * del chat) en campos anidados y que el modelo nunca los vea ni los llene.
 */

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function segments(path: string): string[] {
  const parts = path.split('.').filter(Boolean);
  if (parts.some((p) => FORBIDDEN_SEGMENTS.has(p))) {
    throw new Error(`Ruta de parámetro no permitida: ${path}`);
  }
  return parts;
}

/** Asigna `value` en `path`, creando objetos intermedios si faltan. */
export function setByPath(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = segments(path);
  let node: Record<string, unknown> = target;
  for (const key of parts.slice(0, -1)) {
    const next = node[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

/**
 * Quita `path` del JSON Schema expuesto al modelo (propiedad y `required`).
 * Los objetos intermedios se conservan.
 */
export function stripSchemaPath<T extends Record<string, unknown>>(
  schema: T,
  path: string,
): T {
  const [head, ...rest] = segments(path);
  const properties = schema?.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!properties || !(head in properties)) return schema;

  const next: Record<string, Record<string, unknown>> = { ...properties };
  if (rest.length === 0) {
    delete next[head];
    const required = Array.isArray(schema.required)
      ? (schema.required as string[]).filter((r) => r !== head)
      : schema.required;
    return { ...schema, properties: next, required };
  }

  next[head] = stripSchemaPath(next[head], rest.join('.'));
  return { ...schema, properties: next };
}

/** JSON con claves ordenadas en todos los niveles (para hashes estables). */
export function canonicalJson(value: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, canonical(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(canonical(value));
}
