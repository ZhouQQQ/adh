import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ID_PATTERN = /^[a-f0-9]{64}$/;

/** 按内容 sha256 存储安装包，天然去重。 */
export class PackageStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  static hash(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  private filePath(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error('invalid package id');
    return path.join(this.dir, `${id}.apk`);
  }

  save(id: string, data: Buffer): void {
    fs.writeFileSync(this.filePath(id), data);
  }

  read(id: string): Buffer | null {
    try {
      return fs.readFileSync(this.filePath(id));
    } catch {
      return null;
    }
  }

  path(id: string): string {
    return this.filePath(id);
  }

  has(id: string): boolean {
    if (!ID_PATTERN.test(id)) return false;
    return fs.existsSync(this.filePath(id));
  }
}