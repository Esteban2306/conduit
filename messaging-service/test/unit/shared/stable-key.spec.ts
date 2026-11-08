import {
  resolveUniqueKey,
  slugifyKey,
  STABLE_KEY_PATTERN,
} from 'src/shared/stable-key';

describe('claves estables', () => {
  it('convierte un nombre en una clave válida sin tildes ni símbolos', () => {
    expect(slugifyKey('Línea de Ventas #1', 'line')).toBe('linea-de-ventas-1');
  });

  it('usa el valor por defecto si el nombre no aporta letras ni números', () => {
    expect(slugifyKey('¡¡¡', 'line')).toBe('line');
  });

  it('nunca supera el máximo y siempre cumple el patrón', () => {
    const key = slugifyKey('a'.repeat(200), 'line');
    expect(key.length).toBeLessThanOrEqual(64);
    expect(STABLE_KEY_PATTERN.test(key)).toBe(true);
  });

  it('agrega un sufijo numérico cuando la clave ya existe', async () => {
    const taken = new Set(['ventas', 'ventas-2']);
    const key = await resolveUniqueKey('ventas', async (k) => taken.has(k));
    expect(key).toBe('ventas-3');
  });

  it('deja la clave intacta cuando está libre', async () => {
    expect(await resolveUniqueKey('ventas', async () => false)).toBe('ventas');
  });
});
