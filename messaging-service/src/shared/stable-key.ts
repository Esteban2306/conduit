export const STABLE_KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const STABLE_KEY_MESSAGE =
  'La clave debe ir en minúsculas, con letras, números y guiones simples (ej. "linea-ventas").';
export const STABLE_KEY_MAX_LENGTH = 64;

export function slugifyKey(name: string, fallback: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, STABLE_KEY_MAX_LENGTH - 5)
    .replace(/-+$/g, '');
  return slug || fallback;
}

export async function resolveUniqueKey(
  base: string,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string> {
  if (!(await exists(base))) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`No se pudo generar una clave única a partir de "${base}".`);
}
