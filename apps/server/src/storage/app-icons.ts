import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { OssStore } from './oss.js';

function reportOssError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[oss] 对象存储操作失败：${message}`);
}

/**
 * 应用图标缓存：按「包名@版本」存 PNG，本地一份、OSS 一份。
 * 对象路径：<prefix>/app-icons/<hash>.png
 */
export class AppIconStore {
  constructor(
    private readonly dir: string,
    private readonly oss: OssStore | null = null,
  ) {
    fs.mkdirSync(dir, { recursive: true });
  }

  key(packageName: string, version: string | null): string {
    return createHash('sha1')
      .update(`${packageName}@${version ?? 'unknown'}`)
      .digest('hex')
      .slice(0, 32);
  }

  private filePath(key: string): string {
    return path.join(this.dir, `${key}.png`);
  }

  private ossKey(key: string): string | null {
    return this.oss ? this.oss.key('app-icons', `${key}.png`) : null;
  }

  has(key: string): boolean {
    return fs.existsSync(this.filePath(key));
  }

  read(key: string): Buffer | null {
    try {
      return fs.readFileSync(this.filePath(key));
    } catch {
      return null;
    }
  }

  save(key: string, data: Buffer): void {
    fs.writeFileSync(this.filePath(key), data);
    const ossKey = this.ossKey(key);
    if (ossKey) {
      void this.oss!.put(ossKey, data, 'image/png').catch(reportOssError);
    }
  }

  /** 本地没有时尝试从 OSS 拉一份回来。 */
  async ensureLocal(key: string): Promise<boolean> {
    if (this.has(key)) return true;
    const ossKey = this.ossKey(key);
    if (!ossKey) return false;

    try {
      const data = await this.oss!.get(ossKey);
      if (!data) return false;
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.filePath(key), data);
      return true;
    } catch (error) {
      reportOssError(error);
      return false;
    }
  }
}