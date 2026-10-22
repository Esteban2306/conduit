const SECRET_SHAPES: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-or-[A-Za-z0-9_-]{8,}/g,
  /sk-proj-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bgsk_[A-Za-z0-9]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\benc:v1:[0-9a-f:]{16,}/g,
];

const SECRET_FIELD_NAMES =
  /^(api[-_]?key|apikey|secret|authorization|x-api-key|password|token|access[-_]?token|refresh[-_]?token)$/i;

export function maskSecrets(text: string): string {
  return SECRET_SHAPES.reduce(
    (out, shape) => out.replace(shape, '[clave oculta]'),
    text,
  );
}

export function looksLikeSecret(value: string): boolean {
  return SECRET_SHAPES.some((shape) => {
    shape.lastIndex = 0;
    return shape.test(value);
  });
}

export function findSecrets(value: unknown, path = '$'): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    return looksLikeSecret(value) ? [`${path} (valor con forma de clave)`] : [];
  }
  if (typeof value !== 'object') return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => findSecrets(item, `${path}[${i}]`));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => {
      const here = `${path}.${key}`;
      const named =
        SECRET_FIELD_NAMES.test(key) &&
        key.toLowerCase() !== 'apikeylast4' &&
        child !== null &&
        child !== undefined &&
        !(typeof child === 'string' && /^(•+|\*+)$/.test(child))
          ? [`${here} (campo de secreto)`]
          : [];
      return [...named, ...findSecrets(child, here)];
    },
  );
}

export function maskError(error: unknown): string {
  return maskSecrets(error instanceof Error ? error.message : String(error));
}
