import type {
  AgentDetail,
  AgentSummary,
  CreateAgentResponse,
  DeviceSummary,
  SafeKeyboardLayout,
} from '@adh/protocol';

export interface DeviceFileEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: string;
}

export type PackageKind = 'apk' | 'ipa';

export interface PackageRecord {
  id: string;
  name: string;
  size: number;
  uploadedAt: number;
  kind: PackageKind;
}

export interface DeviceApp {
  name: string;
  /** iOS 才有可读名称；Android 用包名推断 */
  label?: string;
  version: string | null;
  /** APK 大小（字节），拿不到为 null */
  size: number | null;
  installedAt: string | null;
  lastUsedAt: string | null;
}

export interface DeviceRuntime {
  battery: { level: number | null; charging: boolean; status: string };
  memory: { totalMb: number; usedMb: number | null } | null;
  storage: { totalMb: number; usedMb: number } | null;
  wifi: { connected: boolean; ssid: string | null; enabled: boolean; ip?: string | null } | null;
}

export interface ServerInfo {
  version: string;
  port: number;
  storage?:
    | { driver: 'local' }
    | { driver: 'oss'; bucket: string; prefix: string };
}

export type Role = 'admin' | 'operator';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string | null;
  role: Role;
}

export interface UserRecord extends AuthUser {
  enabled: boolean;
  createdAt: number;
  lastLoginAt: number;
}

export interface AuditRecord {
  id: string;
  userId: string | null;
  username: string | null;
  displayName: string | null;
  role: string | null;
  action: string;
  target: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  ip: string | null;
  detail: string | null;
  createdAt: number;
}

export interface DeviceLogRecord {
  id: string;
  deviceId: string | null;
  deviceName: string | null;
  userId: string | null;
  username: string | null;
  displayName: string | null;
  action: string;
  detail: string | null;
  ip: string | null;
  createdAt: number;
}

function authHeaders(
  extra?: Record<string, string>,
): Record<string, string> {
  const token = localStorage.getItem('adh.token');
  return {
    ...(extra ?? {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
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
  const token = localStorage.getItem('adh.token');
  if (token && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${token}`);
  }
  const response = await fetch(url, { ...init, headers });
  if (response.status === 401) {
    localStorage.removeItem('adh.token');
    window.dispatchEvent(new Event('adh:unauthorized'));
  }
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
  login(
    username: string,
    password: string,
  ): Promise<{ token: string; user: AuthUser }> {
    return request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  },

  logout(): Promise<void> {
    return request('/api/auth/logout', { method: 'POST' });
  },

  me(): Promise<{ user: AuthUser | null }> {
    return request('/api/auth/me');
  },

  listUsers(): Promise<{ users: UserRecord[] }> {
    return request('/api/users');
  },

  createUser(body: {
    username: string;
    password: string;
    role: Role;
    displayName?: string | null;
  }): Promise<{ user: UserRecord }> {
    return request('/api/users', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  updateUser(
    id: string,
    body: {
      displayName?: string | null;
      role?: Role;
      enabled?: boolean;
      password?: string;
    },
  ): Promise<{ user: UserRecord }> {
    return request(`/api/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  },

  deleteUser(id: string): Promise<void> {
    return request(`/api/users/${id}`, { method: 'DELETE' });
  },

  listAudit(params?: {
    limit?: number;
    offset?: number;
    username?: string;
    action?: string;
  }): Promise<{ logs: AuditRecord[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    if (params?.username) query.set('username', params.username);
    if (params?.action) query.set('action', params.action);
    const suffix = query.toString();
    return request(`/api/audit${suffix ? `?${suffix}` : ''}`);
  },

  listDeviceLogs(params?: {
    limit?: number;
    offset?: number;
    deviceId?: string;
    username?: string;
    action?: string;
  }): Promise<{ logs: DeviceLogRecord[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    if (params?.deviceId) query.set('deviceId', params.deviceId);
    if (params?.username) query.set('username', params.username);
    if (params?.action) query.set('action', params.action);
    const suffix = query.toString();
    return request(`/api/device-logs${suffix ? `?${suffix}` : ''}`);
  },
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

  updateDevice(
    id: string,
    patch: {
      publishedAt?: number;
      safeKeyboard?: SafeKeyboardLayout | null;
    },
  ): Promise<DeviceSummary> {
    return request(`/api/devices/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  async uploadDeviceThumbnail(
    deviceId: string,
    blob: Blob,
  ): Promise<DeviceSummary> {
    const response = await fetch(`/api/devices/${deviceId}/thumbnail`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'image/jpeg' }),
      body: blob,
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
    return (await response.json()) as DeviceSummary;
  },

  deleteDevice(id: string): Promise<void> {
    return request(`/api/devices/${id}`, { method: 'DELETE' });
  },

  /** 设备实时运行状态（电量 / 内存 / 存储 / WiFi）。 */
  getDeviceRuntime(deviceId: string): Promise<DeviceRuntime> {
    return request(`/api/devices/${deviceId}/runtime`);
  },

  /** 只看电量，设备卡片用。 */
  getDeviceBattery(
    deviceId: string,
  ): Promise<{ battery: DeviceRuntime['battery'] }> {
    return request(`/api/devices/${deviceId}/battery`);
  },

  agentPackageUrl(platform?: string): string {
    const query = new URLSearchParams();
    if (platform) query.set('platform', platform);
    const token = localStorage.getItem('adh.token');
    if (token) query.set('token', token);
    return `/api/agent/download?${query.toString()}`;
  },

  agentPlatforms(): Promise<{
    platforms: { platform: string; file: string; size: number; updatedAt: number }[];
  }> {
    return request('/api/agent/platforms');
  },

  /** 设备网络信息（SSID / IP）。 */
  deviceNetwork(deviceId: string): Promise<{
    platform: string;
    connected: boolean;
    ssid: string | null;
    ip: string | null;
  }> {
    return request(`/api/devices/${deviceId}/network`);
  },

  /** 创建投屏会话。 */
  createStream(
    deviceId: string,
    quality: 'low' | 'medium' | 'high' = 'medium',
  ): Promise<{ sessionId: string }> {
    return request(`/api/devices/${deviceId}/stream`, {
      method: 'POST',
      body: JSON.stringify({ quality }),
    });
  },

  /** 上传安装包（apk / ipa，原始二进制，按 sha256 去重）。 */
  async uploadPackage(
    file: File,
  ): Promise<{ id: string; name: string; size: number; kind: PackageKind }> {
    const isIpa = file.name.toLowerCase().endsWith('.ipa');
    const response = await fetch('/api/packages', {
      method: 'POST',
      headers: authHeaders({
        'content-type': isIpa
          ? 'application/octet-stream'
          : 'application/vnd.android.package-archive',
        'x-file-name': encodeURIComponent(file.name),
      }),
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
    return (await response.json()) as {
      id: string;
      name: string;
      size: number;
      kind: PackageKind;
    };
  },

  /** 切换画质：重建投屏会话。 */
  restartStream(
    deviceId: string,
    quality: 'low' | 'medium' | 'high',
  ): Promise<{ sessionId: string }> {
    return request(`/api/devices/${deviceId}/stream/restart`, {
      method: 'POST',
      body: JSON.stringify({ quality }),
    });
  },

  /** 管理员强制断开该设备的投屏。 */
  kickDeviceStream(deviceId: string): Promise<{ ok: boolean }> {
    return request(`/api/devices/${deviceId}/stream/kick`, { method: 'POST' });
  },

  /** 在指定设备上安装已上传的 APK / IPA。 */
  installPackage(deviceId: string, packageId: string): Promise<{ ok: boolean }> {
    return request(`/api/devices/${deviceId}/install`, {
      method: 'POST',
      body: JSON.stringify({ packageId }),
    });
  },

  listPackages(): Promise<{ packages: PackageRecord[] }> {
    return request('/api/packages');
  },

  renamePackage(
    id: string,
    name: string,
  ): Promise<{ package: PackageRecord }> {
    return request(`/api/packages/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
  },

  deletePackage(id: string): Promise<void> {
    return request(`/api/packages/${id}`, { method: 'DELETE' });
  },

  packageFileUrl(id: string): string {
    const token = localStorage.getItem('adh.token');
    return `/api/packages/${id}/file${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  },

  listDeviceApps(
    deviceId: string,
    includeSystem = false,
  ): Promise<{ packages: DeviceApp[] }> {
    const query = includeSystem ? '?system=1' : '';
    return request(`/api/devices/${deviceId}/apps${query}`);
  },

  deviceAppExportUrl(deviceId: string, packageName: string): string {
    const query = new URLSearchParams({ package: packageName });
    const token = localStorage.getItem('adh.token');
    if (token) query.set('token', token);
    return `/api/devices/${deviceId}/apps/export?${query.toString()}`;
  },

  deviceAppIconUrl(
    deviceId: string,
    packageName: string,
    version: string | null,
  ): string {
    const query = new URLSearchParams({ package: packageName });
    if (version) query.set('version', version);
    const token = localStorage.getItem('adh.token');
    if (token) query.set('token', token);
    return `/api/devices/${deviceId}/apps/icon?${query.toString()}`;
  },

  uninstallDeviceApp(
    deviceId: string,
    packageName: string,
  ): Promise<{ ok: boolean }> {
    return request(`/api/devices/${deviceId}/apps/uninstall`, {
      method: 'POST',
      body: JSON.stringify({ package: packageName }),
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
      { headers: authHeaders() },
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
        headers: authHeaders({
          'content-type': 'application/octet-stream',
          'x-file-name': encodeURIComponent(file.name),
        }),
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

  async downloadDeviceFilesZip(
    deviceId: string,
    paths: string[],
  ): Promise<Blob> {
    const response = await fetch(`/api/devices/${deviceId}/files/archive`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ paths }),
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
    return await response.blob();
  },

  deleteDeviceFiles(
    deviceId: string,
    paths: string[],
  ): Promise<{ ok: boolean; count: number }> {
    return request(`/api/devices/${deviceId}/files/delete`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    });
  },

  renameDeviceFile(
    deviceId: string,
    filePath: string,
    newName: string,
  ): Promise<{ ok: boolean; path: string }> {
    return request(`/api/devices/${deviceId}/files/rename`, {
      method: 'POST',
      body: JSON.stringify({ path: filePath, newName }),
    });
  },

  pasteDeviceFiles(
    deviceId: string,
    paths: string[],
    targetDir: string,
    mode: 'copy' | 'move',
  ): Promise<{ ok: boolean; count: number }> {
    return request(`/api/devices/${deviceId}/files/paste`, {
      method: 'POST',
      body: JSON.stringify({ paths, targetDir, mode }),
    });
  },
};

export function thumbnailUrl(device: DeviceSummary): string {
  const query = new URLSearchParams({ v: String(device.thumbnailAt) });
  const token = localStorage.getItem('adh.token');
  if (token) query.set('token', token);
  return `/api/devices/${device.id}/thumbnail?${query.toString()}`;
}