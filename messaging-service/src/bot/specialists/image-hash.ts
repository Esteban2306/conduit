import { createHash } from 'crypto';
import sharp from 'sharp';

export const RAW_HASH_VERSION = 1;
export const NORMALIZED_HASH_VERSION = 2;
const NORMALIZED_MAX_SIDE = 1568;

export interface ImageHash {
  hash: string;
  version: number;
}

export async function hashImage(buffer: Buffer): Promise<ImageHash> {
  try {
    const { data, info } = await sharp(buffer)
      .rotate()
      .resize(NORMALIZED_MAX_SIDE, NORMALIZED_MAX_SIDE, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });

    const hash = createHash('sha256')
      .update(`${info.width}x${info.height}x${info.channels}:`)
      .update(data)
      .digest('hex');
    return { hash, version: NORMALIZED_HASH_VERSION };
  } catch {
    return {
      hash: createHash('sha256').update(buffer).digest('hex'),
      version: RAW_HASH_VERSION,
    };
  }
}
