import fs from 'node:fs';
import path from 'node:path';
import type { OssStore } from './oss.js';

function reportOssError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[oss] 对象存储操作失败：${message}`);
}

/**
 * 设备缩略图按 deviceId 落盘，agent 上传后覆盖写入。
 * 配置了 OSS 时同步一份到 adh/thumbnails/<deviceId>.jpg。
 */
export class ThumbnailStore {
  constructor(
    private readonly dir: string,
    private readonly oss: OssStore | null = null,
  ) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private filePath(deviceId: string): string {
    return path.join(this.dir, `${deviceId}.jpg`);
  }

  private ossKey(deviceId: string): string | null {
    return this.oss ? this.oss.key('thumbnails', `${deviceId}.jpg`) : null;
  }

  save(deviceId: string, data: Buffer): void {
    fs.writeFileSync(this.filePath(deviceId), data);

    const key = this.ossKey(deviceId);
    if (key) {
      void this.oss!.put(key, data, 'image/jpeg').catch(reportOssError);
    }
  }

  /** 本地缺图时从 OSS 拉回来。 */
  async ensureLocal(deviceId: string): Promise<boolean> {
    if (this.read(deviceId)) return true;
    const key = this.ossKey(deviceId);
    if (!key) return false;

    try {
      const data = await this.oss!.get(key);
      if (!data) return false;
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.filePath(deviceId), data);
      return true;
    } catch (error) {
      reportOssError(error);
      return false;
    }
  }

  read(deviceId: string): Buffer | null {
    try {
      return fs.readFileSync(this.filePath(deviceId));
    } catch {
      return null;
    }
  }

  remove(deviceId: string): void {
    const key = this.ossKey(deviceId);
    if (key) void this.oss!.delete(key).catch(reportOssError);

    try {
      fs.unlinkSync(this.filePath(deviceId));
    } catch {
      /* 文件不存在时忽略 */
    }
  }
}