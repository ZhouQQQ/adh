import type {
  AgentDetail,
  AgentSummary,
  CreateAgentResponse,
  DeviceSummary,
} from '@adh/protocol';

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
};

export function thumbnailUrl(device: DeviceSummary): string {
  return `/api/devices/${device.id}/thumbnail?v=${device.thumbnailAt}`;
}