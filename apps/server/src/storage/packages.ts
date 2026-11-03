import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SqlDriver } from '../db/driver.js';
import type { OssStore } from './oss.js';

const ID_PATTERN = /^[a-f0-9]{64}$/;

export type PackageKind = 'apk' | 'ipa';

export interface PackageRecord {
  id: string;
  name: string;
  size: number;
  uploadedAt: number;
  kind: PackageKind;
  /** 人工备注，可为空。 */
  remark: string | null;
  /** 人工标签。 */
  tags: string[];
}

/** 按后缀判断安装包类型，无法识别时按 APK 处理。 */
export function packageKind(name: string): PackageKind {
  return name.toLowerCase().endsWith('.ipa') ? 'ipa' : 'apk';
}

const SELECT_COLUMNS =
  'id, name, kind, size, remark, tags, uploaded_at AS uploadedAt';

interface PackageRowRecord {
  id: string;
  name: string;
  kind: string;
  size: number;
  uploadedAt: number;
  remark: string | null;
  tags: string | null;
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.map((item) => String(item)).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function toPackageRecord(row: PackageRowRecord): PackageRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === 'ipa' ? 'ipa' : 'apk',
    size: Number(row.size),
    uploadedAt: Number(row.uploadedAt),
    remark: row.remark ?? null,
    tags: parseTags(row.tags),
  };
}

function reportOssError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[oss] 对象存储操作失败：${message}`);
}

interface CountRow {
  total: number;
}

/**
 * 安装包元数据存 adh_packages 表，文件本体按 sha256 存在 data/packages 下，天然去重。
 * 配置了 OSS 时同步一份到 adh/packages/<id>.<kind>，本地保留作 adb 安装缓存。
 */
export class PackageStore {
  private readonly legacyIndexPath: string;

  private constructor(
    private readonly dir: string,
    private readonly db: SqlDriver,
    private readonly oss: OssStore | null = null,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.legacyIndexPath = path.join(dir, 'index.json');
  }

  static async create(
    dir: string,
    db: SqlDriver,
    oss: OssStore | null = null,
  ): Promise<PackageStore> {
    const store = new PackageStore(dir, db, oss);
    await store.importLegacyIndex();
    return store;
  }

  static hash(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
  }

  /** 早期版本把索引写在 index.json，这里一次性搬进数据库。 */
  private async importLegacyIndex(): Promise<void> {
    if (!fs.existsSync(this.legacyIndexPath)) return;

    const [count] = await this.db.query<CountRow>(
      'SELECT COUNT(*) AS total FROM adh_packages',
    );
    if (Number(count?.total ?? 0) > 0) return;

    try {
      const raw = JSON.parse(
        fs.readFileSync(this.legacyIndexPath, 'utf8'),
      ) as Partial<PackageRecord>[];
      const insert =
        this.db.dialect === 'mysql'
          ? 'INSERT IGNORE INTO adh_packages'
          : 'INSERT OR IGNORE INTO adh_packages';
      for (const record of raw) {
        if (!record?.id || !ID_PATTERN.test(record.id) || !record.name) continue;
        await this.db.execute(
          `${insert} (id, name, kind, size, uploaded_at) VALUES (?, ?, ?, ?, ?)`,
          [
            record.id,
            record.name,
            record.kind === 'ipa' ? 'ipa' : packageKind(record.name),
            record.size ?? 0,
            record.uploadedAt ?? Date.now(),
          ],
        );
      }
      fs.renameSync(this.legacyIndexPath, `${this.legacyIndexPath}.bak`);
    } catch {
      /* 旧的 index.json 损坏时忽略，不影响启动 */
    }
  }

  private filePath(id: string, kind: PackageKind): string {
    if (!ID_PATTERN.test(id)) throw new Error('invalid package id');
    return path.join(this.dir, `${id}.${kind}`);
  }

  private ossKey(id: string, kind: PackageKind): string | null {
    return this.oss ? this.oss.key('packages', `${id}.${kind}`) : null;
  }

  private async kindOf(id: string): Promise<PackageKind> {
    return (await this.record(id))?.kind ?? 'apk';
  }

  async save(id: string, data: Buffer, name: string): Promise<PackageRecord> {
    const kind = packageKind(name);
    const existing = await this.record(id);

    // 同一份内容换了后缀：先清掉旧扩展名的文件，避免残留
    if (existing && existing.kind !== kind) {
      try {
        fs.unlinkSync(this.filePath(id, existing.kind));
      } catch {
        /* 旧文件可能已不存在 */
      }
      const staleKey = this.ossKey(id, existing.kind);
      if (staleKey) void this.oss?.delete(staleKey).catch(reportOssError);
    }

    fs.writeFileSync(this.filePath(id, kind), data);

    const upsert =
      this.db.dialect === 'mysql'
        ? `ON DUPLICATE KEY UPDATE
             name = VALUES(name), kind = VALUES(kind), size = VALUES(size)`
        : `ON CONFLICT(id) DO UPDATE SET
             name = excluded.name, kind = excluded.kind, size = excluded.size`;

    await this.db.execute(
      `INSERT INTO adh_packages (id, name, kind, size, uploaded_at)
       VALUES (?, ?, ?, ?, ?)
       ${upsert}`,
      [id, name, kind, data.length, existing?.uploadedAt ?? Date.now()],
    );

    const key = this.ossKey(id, kind);
    if (key) {
      try {
        await this.oss!.put(
          key,
          data,
          kind === 'ipa'
            ? 'application/octet-stream'
            : 'application/vnd.android.package-archive',
        );
      } catch (error) {
        reportOssError(error);
      }
    }

    return (await this.record(id))!;
  }

  /** 本地缺文件时从 OSS 拉回来，供 adb install / 下载使用。 */
  async ensureLocal(id: string): Promise<boolean> {
    const kind = await this.kindOf(id);
    if (await this.has(id)) return true;
    const key = this.ossKey(id, kind);
    if (!key) return false;

    try {
      const data = await this.oss!.get(key);
      if (!data) return false;
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.filePath(id, kind), data);
      return true;
    } catch (error) {
      reportOssError(error);
      return false;
    }
  }

  /** 仅改显示名；后缀/类型不允许在这里变化。 */
  async rename(id: string, name: string): Promise<PackageRecord | null> {
    const record = await this.record(id);
    if (!record || !(await this.has(id))) return null;
    await this.db.execute('UPDATE adh_packages SET name = ? WHERE id = ?', [
      name,
      id,
    ]);
    return (await this.record(id)) ?? null;
  }

  async list(): Promise<PackageRecord[]> {
    const rows = await this.db.query<PackageRowRecord>(
      `SELECT ${SELECT_COLUMNS} FROM adh_packages ORDER BY uploaded_at DESC`,
    );
    return rows.map(toPackageRecord);
  }

  async record(id: string): Promise<PackageRecord | undefined> {
    if (!ID_PATTERN.test(id)) return undefined;
    const [row] = await this.db.query<PackageRowRecord>(
      `SELECT ${SELECT_COLUMNS} FROM adh_packages WHERE id = ?`,
      [id],
    );
    return row ? toPackageRecord(row) : undefined;
  }

  /** 更新显示名、备注或标签；只动元数据，不碰文件。 */
  async updateMeta(
    id: string,
    patch: { name?: string; remark?: string | null; tags?: string[] },
  ): Promise<PackageRecord | null> {
    const record = await this.record(id);
    if (!record) return null;

    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name);
    }
    if (patch.remark !== undefined) {
      sets.push('remark = ?');
      params.push(patch.remark?.trim() ? patch.remark.trim() : null);
    }
    if (patch.tags !== undefined) {
      sets.push('tags = ?');
      params.push(JSON.stringify(patch.tags));
    }
    if (sets.length === 0) return record;

    params.push(id);
    await this.db.execute(
      `UPDATE adh_packages SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );
    return (await this.record(id)) ?? null;
  }

  async read(id: string): Promise<Buffer | null> {
    try {
      return fs.readFileSync(this.filePath(id, await this.kindOf(id)));
    } catch {
      return null;
    }
  }

  async path(id: string): Promise<string> {
    return this.filePath(id, await this.kindOf(id));
  }

  async has(id: string): Promise<boolean> {
    if (!ID_PATTERN.test(id)) return false;
    return fs.existsSync(this.filePath(id, await this.kindOf(id)));
  }

  async remove(id: string): Promise<boolean> {
    if (!ID_PATTERN.test(id)) return false;
    const kind = await this.kindOf(id);
    await this.db.execute('DELETE FROM adh_packages WHERE id = ?', [id]);

    const key = this.ossKey(id, kind);
    if (key) void this.oss?.delete(key).catch(reportOssError);

    try {
      fs.unlinkSync(this.filePath(id, kind));
      return true;
    } catch {
      return false;
    }
  }
}