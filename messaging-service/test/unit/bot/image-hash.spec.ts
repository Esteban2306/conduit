import { createHash, randomBytes } from 'crypto';
import sharp from 'sharp';
import { variablesFingerprint } from 'src/bot/specialists/fingerprint';
import { LEGACY_IMAGE_OUTPUT_SCHEMA } from 'src/bot/specialists/backfill/backfill-specialists';
import { outputSchemaDocumentSchema } from 'src/bot/specialists/contracts';
import { hashImage } from 'src/bot/specialists/image-hash';

const pixels = (width: number, height: number, seed = 0) => {
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + seed) % 256;
  return sharp(data, { raw: { width, height, channels: 3 } });
};

describe('hashImage', () => {
  it('es determinista para la misma imagen', async () => {
    const png = await pixels(64, 48).png().toBuffer();
    const first = await hashImage(png);
    const second = await hashImage(png);
    expect(first).toEqual(second);
    expect(first.version).toBe(2);
    expect(first.hash).toHaveLength(64);
  });

  it('no depende de la codificación sin pérdida ni de los metadatos', async () => {
    const png = await pixels(64, 48).png().toBuffer();
    const pngWithMetadata = await sharp(png)
      .withMetadata({ density: 300 })
      .png({ compressionLevel: 0 })
      .toBuffer();
    const lossless = await sharp(png).webp({ lossless: true }).toBuffer();

    expect(png.equals(pngWithMetadata)).toBe(false);
    const reference = (await hashImage(png)).hash;
    expect((await hashImage(pngWithMetadata)).hash).toBe(reference);
    expect((await hashImage(lossless)).hash).toBe(reference);
  });

  it('un canal alfa completamente opaco no cambia el hash', async () => {
    const opaque = await pixels(32, 32).png().toBuffer();
    const withAlpha = await sharp(opaque).ensureAlpha(1).png().toBuffer();
    expect((await hashImage(withAlpha)).hash).toBe(
      (await hashImage(opaque)).hash,
    );
  });

  it('imágenes distintas dan hashes distintos', async () => {
    const a = await hashImage(await pixels(64, 48, 0).png().toBuffer());
    const b = await hashImage(await pixels(64, 48, 1).png().toBuffer());
    const c = await hashImage(await pixels(48, 64, 0).png().toBuffer());
    expect(new Set([a.hash, b.hash, c.hash]).size).toBe(3);
  });

  it('LIMITACIÓN CONOCIDA: una recompresión con pérdida cambia el hash', async () => {
    const original = await pixels(200, 200).png().toBuffer();
    const recompressed = await sharp(original).jpeg({ quality: 60 }).toBuffer();
    expect((await hashImage(recompressed)).hash).not.toBe(
      (await hashImage(original)).hash,
    );
  });

  it('una imagen enorme se normaliza al mismo tamaño máximo', async () => {
    const big = await pixels(3200, 2000).png().toBuffer();
    const result = await hashImage(big);
    expect(result.version).toBe(2);
    expect(await hashImage(big)).toEqual(result);
  });

  it('un archivo que no es imagen cae al hash de bytes con versión 1', async () => {
    const junk = randomBytes(128);
    expect(await hashImage(junk)).toEqual({
      hash: createHash('sha256').update(junk).digest('hex'),
      version: 1,
    });
  });
});

describe('variablesFingerprint', () => {
  const fields = (extra: Record<string, unknown> = {}) => ({
    amount: 150000,
    currency: 'COP',
    date: '2026-11-08',
    reference: 'TRX-48210377',
    recipient: 'Spa Demo',
    legibility: 'CLEAR',
    ...extra,
  });
  const fingerprint = (extra: Record<string, unknown> = {}) =>
    variablesFingerprint(
      outputSchemaDocumentSchema.parse(LEGACY_IMAGE_OUTPUT_SCHEMA),
      fields(extra),
    );

  it('da una huella de 64 caracteres', () => {
    expect(fingerprint()).toHaveLength(64);
  });

  it('ignora mayúsculas, espacios y signos de la referencia', () => {
    const base = fingerprint();
    expect(fingerprint({ reference: 'trx 48210377' })).toBe(base);
    expect(fingerprint({ reference: ' TRX48210377. ' })).toBe(base);
  });

  it('el monto entero y con decimales cero coinciden', () => {
    expect(fingerprint({ amount: 150000.0 })).toBe(fingerprint());
  });

  it('lo que no está en uniqueBy no cambia la huella', () => {
    expect(fingerprint({ recipient: 'Otro', currency: 'USD' })).toBe(
      fingerprint(),
    );
  });

  it.each([
    ['monto', { amount: 150001 }],
    ['fecha', { date: '2026-11-09' }],
    ['referencia', { reference: 'TRX-48210378' }],
  ])('cambia si cambia la %s', (_name, extra) => {
    expect(fingerprint(extra)).not.toBe(fingerprint());
  });

  it.each([
    ['sin referencia', { reference: null }],
    ['sin monto', { amount: null }],
    ['sin fecha', { date: null }],
    ['referencia demasiado corta', { reference: 'A-1' }],
    ['referencia solo de signos', { reference: '---' }],
  ])('no hay huella %s', (_name, extra) => {
    expect(fingerprint(extra)).toBeNull();
  });

  it('la moneda es opcional', () => {
    expect(fingerprint({ currency: null })).toHaveLength(64);
    expect(fingerprint({ currency: undefined })).toHaveLength(64);
  });
});
