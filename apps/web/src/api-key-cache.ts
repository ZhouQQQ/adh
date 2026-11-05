/**
 * 把用户自己的 API Key 明文缓存在浏览器里。
 *
 * 服务端只存 hash，明文只在创建时返回一次。缓存到 localStorage 后，
 * 同一浏览器刷新 / 重新进入 MCP 页面不用再生成；换设备或清缓存时
 * 可以点「重新生成」拿一把新的。
 */
const PREFIX = 'adh.api-key.';

function storageKey(userId?: string): string {
  return `${PREFIX}${userId ?? 'anonymous'}`;
}

export function readCachedApiKey(userId?: string): string {
  if (!userId) return '';
  try {
    return localStorage.getItem(storageKey(userId)) ?? '';
  } catch {
    return '';
  }
}

export function cacheApiKey(userId: string | undefined, key: string): void {
  if (!userId || !key) return;
  try {
    localStorage.setItem(storageKey(userId), key);
  } catch {
    /* 隐私模式等场景忽略 */
  }
}

export function clearCachedApiKey(userId?: string): void {
  if (!userId) return;
  try {
    localStorage.removeItem(storageKey(userId));
  } catch {
    /* 忽略 */
  }
}