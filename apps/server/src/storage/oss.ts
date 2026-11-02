import OSS from 'ali-oss';
import type { OssConfig } from '../config.js';

const MISSING_CODES = new Set(['NoSuchKey', 'NoSuchObject', 'NotFound']);

function isMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: string; status?: number };
  return value.status === 404 || (value.code ? MISSING_CODES.has(value.code) : false);
}

/**
 * 阿里云 OSS 对象存储。
 * 所有对象都放在 bucket 的 prefix（默认 adh）下，按类型分子目录：
 *   adh/packages/<sha256>.<apk|ipa>
 *   adh/thumbnails/<deviceId>.jpg
 */
export class OssStore {
  private readonly client: OSS;

  constructor(private readonly config: OssConfig) {
    this.client = new OSS({
      region: config.region,
      endpoint: config.endpoint,
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      secure: true,
    });
  }

  get prefix(): string {
    return this.config.prefix;
  }

  get bucket(): string {
    return this.config.bucket;
  }

  key(...parts: string[]): string {
    return [this.config.prefix, ...parts].join('/');
  }

  async put(key: string, data: Buffer, contentType?: string): Promise<void> {
    await this.client.put(key, data, contentType ? { mime: contentType } : undefined);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const result = await this.client.get(key);
      return Buffer.isBuffer(result.content) ? result.content : Buffer.from(result.content);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.delete(key);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  /** 公开读的自定义域名直链，没配置就返回 null。 */
  url(key: string): string | null {
    if (!this.config.publicBaseUrl) return null;
    const base = this.config.publicBaseUrl.replace(/\/+$/, '');
    return `${base}/${key}`;
  }
}