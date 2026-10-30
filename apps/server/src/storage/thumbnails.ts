import fs from 'node:fs';
import path from 'node:path';

/** 设备缩略图按 deviceId 落盘，agent 上传后覆盖写入。 */
export class ThumbnailStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private filePath(deviceId: string): string {
    return path.join(this.dir, `${deviceId}.jpg`);
  }

  save(deviceId: string, data: Buffer): void {
    fs.writeFileSync(this.filePath(deviceId), data);
  }

  read(deviceId: string): Buffer | null {
    try {
      return fs.readFileSync(this.filePath(deviceId));
    } catch {
      return null;
    }
  }

  remove(deviceId: string): void {
    try {
      fs.unlinkSync(this.filePath(deviceId));
    } catch {
      /* 文件不存在时忽略 */
    }
  }
}