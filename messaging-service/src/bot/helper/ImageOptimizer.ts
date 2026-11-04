import sharp from 'sharp';
export class ImageOptimizer {
  private static readonly MAX_WIDTH = 512;
  private static readonly MAX_HEIGHT = 512;
  private static readonly JPEG_QUALITY = 60;
  private static readonly MAX_SIZE_BYTES = 200 * 1024;

  static async optimize(buffer: Buffer): Promise<Buffer> {
    try {
      const metadata = await sharp(buffer).metadata();
      const originalKb = Math.round(buffer.length / 1024);

      const needsResize =
        (metadata.width ?? 0) > this.MAX_WIDTH ||
        (metadata.height ?? 0) > this.MAX_HEIGHT;

      let pipeline = sharp(buffer);

      if (needsResize) {
        pipeline = pipeline.resize(this.MAX_WIDTH, this.MAX_HEIGHT, {
          fit: 'inside',
          withoutEnlargement: true,
        });
      }

      let optimized = await pipeline
        .jpeg({ quality: this.JPEG_QUALITY, mozjpeg: true })
        .toBuffer();

      if (optimized.length > this.MAX_SIZE_BYTES) {
        optimized = await sharp(buffer)
          .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 45, mozjpeg: true })
          .toBuffer();
      }

      const optimizedKb = Math.round(optimized.length / 1024);
      const reduction = Math.round(
        (1 - optimized.length / buffer.length) * 100,
      );

      if (reduction > 10) {
        console.log(
          `[ImageOptimizer] ${originalKb}KB → ${optimizedKb}KB (-${reduction}%)`,
        );
      }

      return optimized;
    } catch {
      return buffer;
    }
  }
}
