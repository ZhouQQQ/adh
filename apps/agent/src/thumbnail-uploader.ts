import type { Logger } from './log.js';

function toHttpBase(serverUrl: string): string {
  return serverUrl
    .replace(/^ws:\/\//i, 'http://')
    .replace(/^wss:\/\//i, 'https://')
    .replace(/\/+$/, '');
}

export class ThumbnailUploader {
  private readonly base: string;

  constructor(
    serverUrl: string,
    private token: string,
    private readonly logger: Logger,
  ) {
    this.base = toHttpBase(serverUrl);
  }

  async upload(udid: string, jpeg: Buffer): Promise<boolean> {
    const url = `${this.base}/api/agent/devices/${encodeURIComponent(udid)}/thumbnail`;
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'image/jpeg',
        },
        body: jpeg,
      });
      if (!response.ok) {
        this.logger.debug(
          { udid, status: response.status },
          'thumbnail upload rejected',
        );
        return false;
      }
      return true;
    } catch (error) {
      this.logger.debug({ udid, err: String(error) }, 'thumbnail upload failed');
      return false;
    }
  }
}