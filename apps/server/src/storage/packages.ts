import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ID_PATTERN = /^[a-f0-9]{64}$/;

export interface PackageRecord {
  id: string;
  name: string;
  size: number;
  uploadedAt: number;
}

/** 按内容 sha256 存储安装包，天然去重；索引写在 index.json。 */
export class PackageStore {
  private readonly indexPath: string;
  private records = new Map<string, PackageRecord>();

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.indexPath = path.join(dir, 'index.json');
    this.loadIndex();
  }

  static hash(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  private loadIndex(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as PackageRecord[];
      for (const record of raw) {
        if (record && ID_PATTERN.test(record.id)) {
          this.records.set(record.id, record);
        }
      }
    } catch {
      /* 首次启动没有索引 */
    }
  }

  private persistIndex(): void {
    const list = [...this.records.values()].sort(
      (a, b) => b.uploadedAt - a.uploadedAt,
    );
    fs.writeFileSync(this.indexPath, JSON.stringify(list, null, 2), 'utf8');
  }

  private filePath(id: string): string {
    if (!ID_PATTERN.test(id)) throw new Error('invalid package id');
    return path.join(this.dir, `${id}.apk`);
  }

  save(id: string, data: Buffer, name: string): PackageRecord {
    fs.writeFileSync(this.filePath(id), data);

    const existing = this.records.get(id);
    const record: PackageRecord = existing
      ? { ...existing, name, size: data.length }
      : { id, name, size: data.length, uploadedAt: Date.now() };

    this.records.set(id, record);
    this.persistIndex();
    return record;
  }

  list(): PackageRecord[] {
    return [...this.records.values()]
      .filter((record) => this.has(record.id))
      .sort((a, b) => b.uploadedAt - a.uploadedAt);
  }

  record(id: string): PackageRecord | undefined {
    return this.records.get(id);
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

  remove(id: string): boolean {
    if (!ID_PATTERN.test(id)) return false;
    this.records.delete(id);
    this.persistIndex();
    try {
      fs.unlinkSync(this.filePath(id));
      return true;
    } catch {
      return false;
    }
  }
}