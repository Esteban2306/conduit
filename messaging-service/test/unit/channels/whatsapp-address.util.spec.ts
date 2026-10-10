import { normalizeWhatsAppAddress } from 'src/channels/whatsapp/utils/whatsapp-address.util';

describe('normalizeWhatsAppAddress', () => {
  it.each([
    ['+573001234567', '573001234567'],
    ['573001234567', '573001234567'],
    ['+57 300 123 4567', '573001234567'],
    ['+57-300-123-4567', '573001234567'],
    ['+57 (300) 123.4567', '573001234567'],
    ['  +573001234567  ', '573001234567'],
    ['+999000000001', '999000000001'],
  ])('normaliza %p a %p', (raw, expected) => {
    expect(normalizeWhatsAppAddress(raw)).toBe(expected);
  });

  it.each([
    ['vacío', ''],
    ['solo "+"', '+'],
    ['demasiado corto', '+57300'],
    ['demasiado largo', '+1234567890123456'],
    ['empieza por 0', '0573001234567'],
    ['contiene letras', '+57300abc4567'],
    ['es un JID', '573001234567@s.whatsapp.net'],
    ['es un email', 'cliente@correo.com'],
    ['doble "+"', '++573001234567'],
  ])('rechaza %s', (_label, raw) => {
    expect(normalizeWhatsAppAddress(raw)).toBeNull();
  });
});
