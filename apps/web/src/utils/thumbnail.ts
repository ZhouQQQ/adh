/**
 * 去掉设备商品图四周的深色纯色背景。
 *
 * 只从图片四条边向内做洪水填充，清除与边缘连通的近黑像素；
 * 机身内部的黑色镜头、屏幕黑边不会动，避免把设备细节一起抠掉。
 */
export async function clearDarkBackground(src: string): Promise<string> {  const image = await loadImage(src);
  const longest = Math.max(image.naturalWidth, image.naturalHeight);
  if (longest <= 0) return src;

  // 缩到 1400px 以内即可，够详情抽屉和后续预览使用，也避免大图处理卡顿
  const scale = Math.min(1, 1400 / longest);
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return src;

  context.drawImage(image, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  const pixels = imageData.data;

  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  const isDark = (index: number): boolean => {
    const offset = index * 4;
    return (
      Math.max(
        pixels[offset] ?? 0,
        pixels[offset + 1] ?? 0,
        pixels[offset + 2] ?? 0,
      ) <= 46
    );
  };

  const push = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (visited[index]) return;
    visited[index] = 1;
    if (!isDark(index)) return;
    queue[tail++] = index;
  };

  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y);
    push(width - 1, y);
  }

  let cleared = 0;
  while (head < tail) {
    const index = queue[head++]!;
    const x = index % width;
    const y = (index / width) | 0;
    pixels[index * 4 + 3] = 0;
    cleared += 1;
    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }

  // 没有大块深色边缘说明图本身不是黑底，直接返回原图
  if (cleared < width * height * 0.02) return src;

  context.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片加载失败'));
    image.src = src;
  });
}

const cache = new Map<string, string>();

/** 带缓存的版本：设备墙多张卡片共用同一张图时只处理一次。 */
export async function clearDarkBackgroundCached(src: string): Promise<string> {
  const hit = cache.get(src);
  if (hit) return hit;
  const result = await clearDarkBackground(src);
  cache.set(src, result);
  if (cache.size > 120) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return result;
}
