import fs from 'node:fs';
import path from 'node:path';
import type { SqlDriver } from '../db/driver.js';

export interface SiteSettings {
  /** 站点标题，空表示用默认。 */
  title: string;
  /** 站点副标题。 */
  subtitle: string;
  /** Logo 最后更新时间，0 表示没有上传。 */
  logoUpdatedAt: number;
  /** 普通用户可同时控制的设备数，0 表示不限。 */
  operatorDeviceLimit: number;
  /** 管理员可同时控制的设备数，0 表示不限（默认）。 */
  adminDeviceLimit: number;
  /** 超级管理员可同时控制的设备数，0 表示不限（默认）。 */
  superadminDeviceLimit: number;
}

const DEFAULT_TITLE = '设备农场';
const DEFAULT_SUBTITLE = 'Device Hub';
/** 普通用户默认只能同时控制 2 台设备。 */
const DEFAULT_OPERATOR_LIMIT = 2;
/** 管理员默认不限。 */
const DEFAULT_ADMIN_LIMIT = 0;
/** 超级管理员默认不限。 */
const DEFAULT_SUPER_LIMIT = 0;

/** 站点级设置：标题和 Logo，存 adh_settings 表，Logo 文件落本地目录。 */
export class SettingsService {
  constructor(
    private readonly db: SqlDriver,
    private readonly logoDir: string,
  ) {
    fs.mkdirSync(logoDir, { recursive: true });
  }

  private logoPath(): string {
    return path.join(this.logoDir, 'logo.png');
  }

  async getValue(name: string): Promise<string | null> {
    const [row] = await this.db.query<{ value: string | null }>(
      'SELECT value FROM adh_settings WHERE name = ?',
      [name],
    );
    return row?.value ?? null;
  }

  async setValue(name: string, value: string | null): Promise<void> {
    await this.db.execute('DELETE FROM adh_settings WHERE name = ?', [name]);
    await this.db.execute(
      'INSERT INTO adh_settings (name, value, updated_at) VALUES (?, ?, ?)',
      [name, value, Date.now()],
    );
  }

  async getSite(): Promise<SiteSettings> {
    const [title, subtitle, logoAt, limit, adminLimit, superLimit] =
      await Promise.all([
        this.getValue('site.title'),
        this.getValue('site.subtitle'),
        this.getValue('site.logoUpdatedAt'),
        this.getValue('control.maxDevices.operator'),
        this.getValue('control.maxDevices.admin'),
        this.getValue('control.maxDevices.superadmin'),
      ]);
    return {
      title: title?.trim() || DEFAULT_TITLE,
      subtitle: subtitle?.trim() || DEFAULT_SUBTITLE,
      logoUpdatedAt: Number(logoAt ?? 0) || 0,
      operatorDeviceLimit:
        limit === null ? DEFAULT_OPERATOR_LIMIT : Math.max(0, Number(limit) || 0),
      adminDeviceLimit:
        adminLimit === null
          ? DEFAULT_ADMIN_LIMIT
          : Math.max(0, Number(adminLimit) || 0),
      superadminDeviceLimit:
        superLimit === null
          ? DEFAULT_SUPER_LIMIT
          : Math.max(0, Number(superLimit) || 0),
    };
  }

  /** 按角色取同时控制上限，0 表示不限。 */
  async getDeviceLimit(role: string): Promise<number> {
    if (role === 'superadmin') {
      const value = await this.getValue('control.maxDevices.superadmin');
      return value === null
        ? DEFAULT_SUPER_LIMIT
        : Math.max(0, Number(value) || 0);
    }
    if (role === 'admin') {
      const value = await this.getValue('control.maxDevices.admin');
      return value === null ? DEFAULT_ADMIN_LIMIT : Math.max(0, Number(value) || 0);
    }
    const value = await this.getValue('control.maxDevices.operator');
    return value === null
      ? DEFAULT_OPERATOR_LIMIT
      : Math.max(0, Number(value) || 0);
  }

  async saveSite(input: {
    title: string;
    subtitle: string;
    operatorDeviceLimit?: number;
    adminDeviceLimit?: number;
    superadminDeviceLimit?: number;
  }): Promise<SiteSettings> {
    await this.setValue('site.title', input.title.trim() || null);
    await this.setValue('site.subtitle', input.subtitle.trim() || null);
    if (input.operatorDeviceLimit !== undefined) {
      await this.setValue(
        'control.maxDevices.operator',
        String(Math.max(0, Math.floor(input.operatorDeviceLimit))),
      );
    }
    if (input.adminDeviceLimit !== undefined) {
      await this.setValue(
        'control.maxDevices.admin',
        String(Math.max(0, Math.floor(input.adminDeviceLimit))),
      );
    }
    if (input.superadminDeviceLimit !== undefined) {
      await this.setValue(
        'control.maxDevices.superadmin',
        String(Math.max(0, Math.floor(input.superadminDeviceLimit))),
      );
    }
    return this.getSite();
  }

  async saveTitle(title: string): Promise<SiteSettings> {
    await this.setValue('site.title', title.trim() || null);
    return this.getSite();
  }

  /** 保存 Logo 图片，返回新的更新时间。 */
  async saveLogo(data: Buffer): Promise<number> {
    fs.writeFileSync(this.logoPath(), data);
    const at = Date.now();
    await this.setValue('site.logoUpdatedAt', String(at));
    return at;
  }

  async removeLogo(): Promise<void> {
    try {
      fs.rmSync(this.logoPath(), { force: true });
    } catch {
      /* 文件可能不存在 */
    }
    await this.setValue('site.logoUpdatedAt', '0');
  }

  readLogo(): Buffer | null {
    try {
      return fs.readFileSync(this.logoPath());
    } catch {
      return null;
    }
  }
}