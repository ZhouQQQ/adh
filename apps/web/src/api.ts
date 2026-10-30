import type {
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
  const response = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
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
};

export function thumbnailUrl(device: DeviceSummary): string {
  return `/api/devices/${device.id}/thumbnail?v=${device.thumbnailAt}`;
}