import sharp from 'sharp';
import { runCommandBuffer } from './exec.js';

/** 截屏并压缩成适合卡片展示的小图。 */
export async function captureThumbnail(udid: string): Promise<Buffer | null> {
  const result = await runCommandBuffer(
    'adb',
    ['-s', udid, 'exec-out', 'screencap', '-p'],
    20_000,
  );
  if (result.code !== 0 || result.stdout.byteLength < 64) return null;

  try {
    return await sharp(result.stdout)
      .resize({ width: 360, withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toBuffer();
  } catch {
    return null;
  }
}