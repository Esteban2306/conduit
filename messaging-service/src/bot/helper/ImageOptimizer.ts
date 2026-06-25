import sharp from 'sharp';

export class ImageOptimizer {
  static async optimize(buffer: Buffer): Promise<Buffer> {
    return sharp(buffer)
      .rotate()
      .resize({
        width: 1024,
        height: 1024,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({
        quality: 80,
        mozjpeg: true,
      })
      .toBuffer();
  }
}
