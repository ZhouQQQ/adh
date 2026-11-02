import type {
  AgentDetail,
  AgentSummary,
  CreateAgentResponse,
  DeviceSummary,
} from '@adh/protocol';

export interface DeviceFileEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: string;
}

export interface ServerInfo {
  version: string;
  port: number;
}

async function request<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  // 只有真正带 body 时才声明 JSON，否则 DELETE 这类空请求会被 Fastify 判定为 400
  if (init?.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* 非 JSON 响应 */
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  health(): Promise<{ ok: boolean; version: string }> {
    return request('/api/health');
  },

  serverInfo(): Promise<ServerInfo> {
    return request('/api/server-info');
  },

  listAgents(): Promise<AgentSummary[]> {
    return request('/api/agents');
  },

  getAgent(id: string): Promise<AgentDetail> {
    return request(`/api/agents/${id}`);
  },

  updateAgent(id: string, name: string): Promise<{ agent: AgentSummary }> {
    return request(`/api/agents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
  },

  createAgent(name: string): Promise<CreateAgentResponse> {
    return request('/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  },

  rotateAgentKey(id: string): Promise<CreateAgentResponse> {
    return request(`/api/agents/${id}/rotate`, { method: 'POST' });
  },

  deleteAgent(id: string): Promise<void> {
    return request(`/api/agents/${id}`, { method: 'DELETE' });
  },

  listDevices(): Promise<DeviceSummary[]> {
    return request('/api/devices');
  },

  deleteDevice(id: string): Promise<void> {
    return request(`/api/devices/${id}`, { method: 'DELETE' });
  },

  cleanupOfflineDevices(): Promise<{ removed: number }> {
    return request('/api/devices/cleanup', { method: 'POST' });
  },

  /** 创建投屏会话。 */
  createStream(deviceId: string): Promise<{ sessionId: string }> {
    return request(`/api/devices/${deviceId}/stream`, { method: 'POST' });
  },

  /** 上传 APK（原始二进制，按 sha256 去重）。 */
  async uploadPackage(
    file: File,
  ): Promise<{ id: string; name: string; size: number }> {
    const response = await fetch('/api/packages', {
      method: 'POST',
      headers: {
        'content-type': 'application/vnd.android.package-archive',
        'x-file-name': encodeURIComponent(file.name),
      },
      body: file,
    });
    if (!response.ok) {
      let msg = `${response.status} ${response.statusText}`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) msg = body.error;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    return (await response.json()) as { id: string; name: string; size: number };
  },

  /** 在指定设备上安装已上传的 APK。 */
  installPackage(deviceId: string, packageId: string): Promise<{ ok: boolean }> {
    return request(`/api/devices/${deviceId}/install`, {
      method: 'POST',
      body: JSON.stringify({ packageId }),
    });
  },

  listFiles(
    deviceId: string,
    dir: string,
  ): Promise<{ path: string; entries: DeviceFileEntry[] }> {
    return request(
      `/api/devices/${deviceId}/files?path=${encodeURIComponent(dir)}`,
    );
  },

  async downloadDeviceFile(
    deviceId: string,
    filePath: string,
  ): Promise<{ blob: Blob; name: string }> {
    const response = await fetch(
      `/api/devices/${deviceId}/files/download?path=${encodeURIComponent(filePath)}`,
    );
    if (!response.ok) {
      let msg = `${response.status} ${response.statusText}`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) msg = body.error;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    const name = filePath.split('/').pop() || 'file';
    return { blob: await response.blob(), name };
  },

  async uploadDeviceFile(
    deviceId: string,
    dir: string,
    file: File,
  ): Promise<{ path: string }> {
    const response = await fetch(
      `/api/devices/${deviceId}/files/upload?dir=${encodeURIComponent(dir)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-file-name': encodeURIComponent(file.name),
        },
        body: file,
      },
    );
    if (!response.ok) {
      let msg = `${response.status} ${response.statusText}`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) msg = body.error;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    return (await response.json()) as { path: string };
  },
};

export function thumbnailUrl(device: DeviceSummary): string {
  return `/api/devices/${device.id}/thumbnail?v=${device.thumbnailAt}`;
}