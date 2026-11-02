import { Jimp } from 'jimp';
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
    const image = await Jimp.read(result.stdout);
    if (image.bitmap.width > 360) {
      image.resize({ w: 360 });
    }
    return await image.getBuffer('image/jpeg', { quality: 72 });
  } catch {
    return null;
  }
}