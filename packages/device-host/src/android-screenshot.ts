import { Jimp } from 'jimp';
import { runCommand, runCommandBuffer } from './exec.js';

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

export interface ScreenshotImage {
  data: Buffer;
  width: number;
  height: number;
}

/** 从 PNG 的 IHDR 块读取宽高，避免为了拿尺寸再解一次图片。 */
export function pngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.byteLength < 24) return null;
  // PNG 签名 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] !== 0x89 ||
    buffer[1] !== 0x50 ||
    buffer[2] !== 0x4e ||
    buffer[3] !== 0x47
  ) {
    return null;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * 全分辨率截图，供 AI 视觉定位使用。
 * 与缩略图不同，这里不做缩放：坐标换算依赖原始分辨率。
 */
export async function captureScreenshot(
  udid: string,
): Promise<ScreenshotImage | null> {
  const result = await runCommandBuffer(
    'adb',
    ['-s', udid, 'exec-out', 'screencap', '-p'],
    20_000,
  );
  if (result.code !== 0 || result.stdout.byteLength < 24) return null;
  const size = pngSize(result.stdout);
  if (!size) return null;
  return { data: result.stdout, ...size };
}

/** 通过 monkey 启动应用，包名不存在时返回 false。 */
export async function launchAndroidApp(
  udid: string,
  packageName: string,
): Promise<boolean> {
  const result = await runCommand(
    'adb',
    [
      '-s',
      udid,
      'shell',
      'monkey',
      '-p',
      packageName,
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    ],
    20_000,
  );
  if (result.code !== 0) return false;
  const output = `${result.stdout}\n${result.stderr}`;
  return /Events injected:\s*\d+/.test(output) && !/No activities found/i.test(output);
}