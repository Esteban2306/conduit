const E164_DIGITS = /^[1-9]\d{9,14}$/;

/**
 * Convierte una dirección de WhatsApp a su forma canónica: solo dígitos E.164
 * (código de país incluido, sin "+"). Acepta los formatos habituales de los
 * sistemas integradores ("+57 300 123 4567", "+57-300-1234567", "573001234567").
 *
 * No adivina el código de país: un número local sin él se rechaza, porque esa
 * regla depende de cada integrador y Conduit debe seguir siendo agnóstico.
 *
 * @returns los dígitos canónicos, o `null` si la dirección no es válida.
 */
export function normalizeWhatsAppAddress(raw: string): string | null {
  const digits = raw
    .trim()
    .replace(/^\+/, '')
    .replace(/[\s\-().]/g, '');

  return E164_DIGITS.test(digits) ? digits : null;
}
