import { randomBytes } from 'crypto';
import sharp from 'sharp';
import { ImageOptimizer } from 'src/bot/helper/ImageOptimizer';

const gradient = (width: number, height: number) => {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      pixels[i] = x % 256;
      pixels[i + 1] = y % 256;
      pixels[i + 2] = (x + y) % 256;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
};

const noise = (width: number, height: number) =>
  sharp(randomBytes(width * height * 3), {
    raw: { width, height, channels: 3 },
  })
    .png()
    .toBuffer();

const meta = (buffer: Buffer) => sharp(buffer).metadata();

describe('ImageOptimizer', () => {
  describe('optimize (análisis legado)', () => {
    it('reduce a 512 px de lado mayor como JPEG', async () => {
      const out = await ImageOptimizer.optimize(await gradient(2000, 1000));
      const info = await meta(out);
      expect(info.format).toBe('jpeg');
      expect(Math.max(info.width ?? 0, info.height ?? 0)).toBeLessThanOrEqual(
        512,
      );
    });
  });

  describe('optimizeForExtraction', () => {
    it('conserva hasta 1568 px de lado mayor, bastante más que el legado', async () => {
      const out = await ImageOptimizer.optimizeForExtraction(
        await gradient(3000, 2000),
      );
      const info = await meta(out);
      expect(info.format).toBe('jpeg');
      expect(info.width).toBe(1568);
      expect(info.height).toBe(1045);
    });

    it('no agranda una imagen pequeña', async () => {
      const out = await ImageOptimizer.optimizeForExtraction(
        await gradient(400, 300),
      );
      const info = await meta(out);
      expect(info.width).toBe(400);
      expect(info.height).toBe(300);
    });

    it('incluso el peor caso (ruido puro) queda por debajo de 1 MB', async () => {
      const out = await ImageOptimizer.optimizeForExtraction(
        await noise(4000, 3000),
      );
      expect(out.length).toBeLessThan(1024 * 1024);
    });

    it('un archivo que no es imagen se devuelve igual, sin lanzar', async () => {
      const junk = Buffer.from('no soy una imagen');
      expect(await ImageOptimizer.optimizeForExtraction(junk)).toBe(junk);
    });

    it('conserva más detalle que el optimizador legado para la misma imagen', async () => {
      const source = await gradient(3000, 2000);
      const legacy = await meta(await ImageOptimizer.optimize(source));
      const extraction = await meta(
        await ImageOptimizer.optimizeForExtraction(source),
      );
      expect(extraction.width ?? 0).toBeGreaterThan((legacy.width ?? 0) * 2);
    });
  });
});
