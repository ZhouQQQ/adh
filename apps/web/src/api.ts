import type {
  AgentDetail,
  AgentSummary,
  CreateAgentResponse,
  DeviceSummary,
  IosTunnelStatus,
  SafeKeyboardLayout,
} from '@adh/protocol';
import { withBase } from './base';

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
  /** 人工备注。 */
  remark: string | null;
  /** 人工标签。 */
  tags: string[];
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
  battery: {
    level: number | null;
    charging: boolean;
    status: string;
    /** 电池温度（摄氏度），设备不提供时为 null。 */
    temperature: number | null;
  };
  memory: { totalMb: number; usedMb: number | null } | null;
  storage: { totalMb: number; usedMb: number } | null;
  wifi: { connected: boolean; ssid: string | null; enabled: boolean; ip?: string | null } | null;
  /** 已开机秒数，拿不到时为 null。 */
  uptimeSeconds: number | null;
}

export interface SiteSettings {
  title: string;
  subtitle: string;
  logoUpdatedAt: number;
  /** 普通用户可同时控制的设备数，0 表示不限。 */
  operatorDeviceLimit: number;
  /** 管理员可同时控制的设备数，0 表示不限。 */
  adminDeviceLimit: number;
  /** 超级管理员可同时控制的设备数，0 表示不限。 */
  superadminDeviceLimit: number;
  /** 控制者无操作自动断开的分钟数，0 表示不自动断开。 */
  idleTimeoutMinutes: number;
}

export interface AiSettingsView {
  enabled: boolean;
  baseUrl: string;
  /** 服务端返回的是打码值，修改时留空表示不变。 */
  apiKey: string;
  hasApiKey: boolean;
  model: string;
  temperature: number;
  systemPrompt: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  enabled: boolean;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  userId?: string;
}

export interface AiChatStep {
  name: string;
  args: Record<string, unknown>;
  detail?: string;
  ok?: boolean;
}

export interface AiChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** 服务端持久化后的消息 id 与时间。 */
  id?: string;
  createdAt?: number;
  /** assistant 消息对应的执行步骤，刷新后用于恢复。 */
  steps?: AiChatStep[];
}

export type AiChatEvent =
  | { type: 'status'; message: string }
  | { type: 'saved'; role: 'user' | 'assistant'; id: string }
  | { type: 'tool'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; ok: boolean; detail: string }
  | { type: 'reply'; content: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface DashboardData {
  users: { total: number; admins: number; enabled: number };
  devices: {
    total: number;
    online: number;
    offline: number;
    unauthorized: number;
    locked: number;
    inUse: number;
    /** 已填写发布时间的设备平均已发布天数。 */
    avgAgeDays: number | null;
    publishedCount: number;
  };
  agents: { total: number; online: number };
  packages: { total: number; apk: number; ipa: number; totalSize: number };
  usage: {
    windowDays: number;
    sessions: number;
    seconds: number;
    todaySessions: number;
    todaySeconds: number;
    todayUsers: number;
    /** 近 7 天有控制记录的用户数。 */
    weekUsers: number;
    /** 统计窗口内有控制记录的用户数。 */
    monthUsers: number;
  };
  deviceRanking: Array<{
    deviceId: string;
    deviceName: string;
    sessions: number;
    seconds: number;
  }>;
  userRanking: Array<{
    username: string;
    displayName: string | null;
    sessions: number;
    seconds: number;
  }>;
  daily: Array<{ date: string; sessions: number; seconds: number }>;
  recent: Array<{
    deviceName: string | null;
    username: string | null;
    displayName: string | null;
    action: string;
    createdAt: number;
  }>;
}

export interface ServerInfo {
  version: string;
  port: number;
  storage?:
    | { driver: 'local' }
    | { driver: 'oss'; bucket: string; prefix: string };
}

export type Role = 'superadmin' | 'admin' | 'operator';

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
  const response = await fetch(withBase(url), { ...init, headers });
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

export interface TaskSnapshot {
  id: string;
  userId: string;
  deviceId: string | null;
  instruction: string;
  status:
    | 'queued'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'cancelled'
    | 'timeout';
  reply: string;
  error: string | null;
  createdAt: number;
  startedAt: number;
  finishedAt: number;
}

export interface BatchTaskInput {
  deviceId: string;
  instruction: string;
  timeoutSec?: number;
}

export interface BatchPlanTask {
  deviceId: string;
  instruction: string;
}

export interface BatchPlan {
  scope: 'single' | 'batch' | 'none';
  mode: 'parallel' | 'sequential';
  summary: string;
  tasks: BatchPlanTask[];
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

  /** 修改自己的登录密码。 */
  changePassword(
    oldPassword: string,
    newPassword: string,
  ): Promise<{ ok: boolean }> {
    return request('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword, newPassword }),
    });
  },

  me(): Promise<{ user: AuthUser | null }> {
    return request('/api/auth/me');
  },

  /** 让 AI 判断一句话是单台还是多台，并拆出每台设备的任务。 */
  planBatchTasks(body: {
    instruction: string;
    deviceIds?: string[];
  }): Promise<{ plan: BatchPlan }> {
    return request('/api/tasks/batch/plan', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  /** 批量创建 AI 任务：相同指令跑多台，或按设备分别指定并按顺序执行。 */
  createBatchTasks(body: {
    instruction?: string;
    deviceIds?: string[];
    tasks?: BatchTaskInput[];
    mode?: 'parallel' | 'sequential';
    timeoutSec?: number;
  }): Promise<{ tasks: TaskSnapshot[] }> {
    return request('/api/tasks/batch', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },

  getTask(id: string): Promise<{ task: TaskSnapshot }> {
    return request(`/api/tasks/${encodeURIComponent(id)}`);
  },

  cancelTask(id: string): Promise<{ ok: boolean }> {
    return request(`/api/tasks/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
      keepalive: true,
    });
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
    role?: string;
    /** 起始时间（毫秒时间戳）。 */
    since?: number;
    /** 结束时间（毫秒时间戳）。 */
    until?: number;
  }): Promise<{ logs: AuditRecord[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    if (params?.username) query.set('username', params.username);
    if (params?.action) query.set('action', params.action);
    if (params?.role) query.set('role', params.role);
    if (params?.since) query.set('since', String(params.since));
    if (params?.until) query.set('until', String(params.until));
    const suffix = query.toString();
    return request(`/api/audit${suffix ? `?${suffix}` : ''}`);
  },

  listDeviceLogs(params?: {
    limit?: number;
    offset?: number;
    deviceId?: string;
    username?: string;
    action?: string;
    /** 起始时间（毫秒时间戳）。 */
    since?: number;
    /** 结束时间（毫秒时间戳）。 */
    until?: number;
  }): Promise<{ logs: DeviceLogRecord[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    if (params?.deviceId) query.set('deviceId', params.deviceId);
    if (params?.username) query.set('username', params.username);
    if (params?.action) query.set('action', params.action);
    if (params?.since) query.set('since', String(params.since));
    if (params?.until) query.set('until', String(params.until));
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

  /** 启动节点上的 iOS 隧道（iOS 17+）。 */
  startAgentTunnel(
    id: string,
  ): Promise<{ ok: boolean; status: IosTunnelStatus }> {
    return request(`/api/agents/${id}/tunnel/start`, { method: 'POST' });
  },

  /** 停止节点上的 iOS 隧道。 */
  stopAgentTunnel(
    id: string,
  ): Promise<{ ok: boolean; status: IosTunnelStatus }> {
    return request(`/api/agents/${id}/tunnel/stop`, { method: 'POST' });
  },

  listDevices(): Promise<DeviceSummary[]> {
    return request('/api/devices');
  },

  updateDevice(
    id: string,
    patch: {
      publishedAt?: number;
      safeKeyboard?: SafeKeyboardLayout | null;
      /** 仅管理员可用：锁定后普通用户不能控制也不能查看。 */
      locked?: boolean;
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
    const response = await fetch(
      withBase(`/api/devices/${deviceId}/thumbnail`),
      {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'image/jpeg' }),
        body: blob,
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
    return withBase(`/api/agent/download?${query.toString()}`);
  },

  agentPlatforms(): Promise<{
    platforms: {
      platform: string;
      file: string;
      size: number;
      updatedAt: number;
      /** local：服务器 dist/ 里的包；release：GitHub Release。 */
      source?: 'local' | 'release';
      url?: string;
    }[];
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
    quality: 'low' | 'medium' | 'high' | 'ultra' = 'medium',
  ): Promise<{ sessionId: string }> {
    return request(`/api/devices/${deviceId}/stream`, {
      method: 'POST',
      body: JSON.stringify({ quality }),
    });
  },

  /**
   * 上传安装包（apk / ipa，原始二进制，按 sha256 去重）。
   * 用 XHR 而不是 fetch：只有 XHR 能拿到上传进度。
   */
  uploadPackage(
    file: File,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<{ id: string; name: string; size: number; kind: PackageKind }> {
    const isIpa = file.name.toLowerCase().endsWith('.ipa');

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', withBase('/api/packages'));
      for (const [key, value] of Object.entries(
        authHeaders({
          'content-type': isIpa
            ? 'application/octet-stream'
            : 'application/vnd.android.package-archive',
          'x-file-name': encodeURIComponent(file.name),
        }),
      )) {
        xhr.setRequestHeader(key, value);
      }

      xhr.upload.addEventListener('progress', (event) => {
        if (!event.lengthComputable) return;
        onProgress?.(event.loaded, event.total);
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(
              JSON.parse(xhr.responseText) as {
                id: string;
                name: string;
                size: number;
                kind: PackageKind;
              },
            );
          } catch {
            reject(new Error('服务器返回内容不合法'));
          }
          return;
        }
        let msg = `${xhr.status} ${xhr.statusText}`;
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string };
          if (body.error) msg = body.error;
        } catch {
          /* ignore */
        }
        reject(new Error(msg));
      });

      xhr.addEventListener('error', () => reject(new Error('网络错误，上传失败')));
      xhr.addEventListener('abort', () => reject(new Error('上传已取消')));
      xhr.send(file);
    });
  },

  /** 切换画质：重建投屏会话。 */
  restartStream(
    deviceId: string,
    quality: 'low' | 'medium' | 'high' | 'ultra',
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

  /** 管理员接管该设备的控制权。 */
  takeoverDeviceStream(deviceId: string): Promise<{ ok: boolean }> {
    return request(`/api/devices/${deviceId}/stream/takeover`, {
      method: 'POST',
    });
  },

  /** 控制者主动断开投屏。 */
  stopDeviceStream(deviceId: string): Promise<{ ok: boolean }> {
    return request(`/api/devices/${deviceId}/stream/stop`, { method: 'POST' });
  },

  /** iOS 申请控制权：同一时间只有一个人能控制。 */
  claimIosControl(deviceId: string): Promise<{
    granted: boolean;
    control?: {
      userId: string;
      username: string;
      displayName?: string;
      since: number;
    };
  }> {
    return request(`/api/devices/${deviceId}/ios/control`, { method: 'POST' });
  },

  /** iOS 控制权心跳，超时服务端会自动释放。 */
  heartbeatIosControl(deviceId: string): Promise<{ ok: boolean }> {
    return request(`/api/devices/${deviceId}/ios/control/heartbeat`, {
      method: 'POST',
    });
  },

  /** 控制者开关是否允许其他人查看。 */
  setStreamViewers(
    deviceId: string,
    allow: boolean,
  ): Promise<{ ok: boolean }> {
    return request(`/api/devices/${deviceId}/stream/viewers`, {
      method: 'POST',
      body: JSON.stringify({ allow }),
    });
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

  getDashboard(): Promise<DashboardData> {
    return request('/api/dashboard');
  },

  getSiteSettings(): Promise<SiteSettings> {
    return request('/api/settings');
  },

  updateSiteTitle(title: string): Promise<SiteSettings> {
    return request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ title }),
    });
  },

  updateSiteSettings(input: {
    title: string;
    subtitle: string;
    operatorDeviceLimit?: number;
    adminDeviceLimit?: number;
    superadminDeviceLimit?: number;
    idleTimeoutMinutes?: number;
  }): Promise<SiteSettings> {
    return request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },

  async uploadSiteLogo(blob: Blob): Promise<{ logoUpdatedAt: number }> {
    const response = await fetch(withBase('/api/settings/logo'), {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'image/png' }),
      body: blob,
    });
    if (!response.ok) {
      let msg = `${response.status} ${response.statusText}`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) msg = body.error;
      } catch {
        /* 非 JSON 响应 */
      }
      throw new Error(msg);
    }
    return response.json() as Promise<{ logoUpdatedAt: number }>;
  },

  removeSiteLogo(): Promise<{ logoUpdatedAt: number }> {
    return request('/api/settings/logo', { method: 'DELETE' });
  },

  getAiSettings(): Promise<AiSettingsView> {
    return request('/api/settings/ai');
  },

  listApiKeys(): Promise<{ keys: ApiKeyRecord[]; key?: string }> {
    return request('/api/api-keys');
  },

  resetApiKey(): Promise<{ key: string; record: ApiKeyRecord }> {
    return request('/api/api-keys/reset', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  createApiKey(
    name: string,
  ): Promise<{ key: string; record: ApiKeyRecord }> {
    return request('/api/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  },

  deleteApiKey(id: string): Promise<{ ok: boolean }> {
    return request(`/api/api-keys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },

  aiStatus(): Promise<{ enabled: boolean }> {
    return request('/api/ai/status');
  },

  getAiMessages(
    deviceId: string,
  ): Promise<{ messages: AiChatMessage[] }> {
    return request(`/api/devices/${deviceId}/ai/messages`);
  },

  clearAiMessages(deviceId: string): Promise<{ ok: boolean }> {
    return request(`/api/devices/${deviceId}/ai/messages`, {
      method: 'DELETE',
    });
  },

  deleteAiMessage(
    deviceId: string,
    messageId: string,
  ): Promise<{ ok: boolean }> {
    return request(
      `/api/devices/${deviceId}/ai/messages/${encodeURIComponent(messageId)}`,
      { method: 'DELETE' },
    );
  },

  updateAiSettings(input: {
    enabled?: boolean;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    temperature?: number;
    systemPrompt?: string;
  }): Promise<AiSettingsView> {
    return request('/api/settings/ai', {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  },

  /**
   * AI 对话：服务端用 SSE 推送每一步进度。
   * 流格式是 event/data 成对出现，最终由 done 事件结束。
   */
  async aiChat(
    deviceId: string,
    message: string,
    onEvent: (event: AiChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch(withBase(`/api/devices/${deviceId}/ai/chat`), {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ message }),
      signal,
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
    if (!response.body) throw new Error('当前浏览器不支持流式响应');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = chunk
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');
        if (data) {
          try {
            onEvent(JSON.parse(data) as AiChatEvent);
          } catch {
            /* 忽略无法解析的事件 */
          }
        }
        index = buffer.indexOf('\n\n');
      }
    }
  },

  cancelAi(deviceId: string): Promise<{ ok: boolean }> {
    return request(`/api/devices/${deviceId}/ai/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  siteLogoUrl(updatedAt: number): string {
    return withBase(`/api/settings/logo?v=${updatedAt}`);
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

  /** 编辑安装包备注与标签。 */
  updatePackageMeta(
    id: string,
    patch: { remark?: string | null; tags?: string[] },
  ): Promise<{ package: PackageRecord }> {
    return request(`/api/packages/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },

  deletePackage(id: string): Promise<void> {
    return request(`/api/packages/${id}`, { method: 'DELETE' });
  },

  packageFileUrl(id: string): string {
    const token = localStorage.getItem('adh.token');
    return withBase(
      `/api/packages/${id}/file${token ? `?token=${encodeURIComponent(token)}` : ''}`,
    );
  },

  /** iOS 切换画质：直接调整 WDA MJPEG 参数，不重建连接。 */
  setIosQuality(
    deviceId: string,
    quality: 'low' | 'medium' | 'high' | 'ultra',
  ): Promise<{ ok: boolean }> {
    return request(`/api/devices/${deviceId}/ios/quality`, {
      method: 'POST',
      body: JSON.stringify({ quality }),
    });
  },

  /** iOS 一键启动 WDA（XCTest + 端口转发）；restart 会先停掉旧实例。 */
  startIosWda(
    deviceId: string,
    restart = false,
  ): Promise<{ ok: boolean; message: string; port: number }> {
    return request(`/api/devices/${deviceId}/ios/wda/start`, {
      method: 'POST',
      body: JSON.stringify({ restart }),
    });
  },

  /** 安装包图标；后台会从 apk / ipa 里解析并缓存。version 用于强制刷新。 */
  packageIconUrl(id: string, version?: number): string {
    const token = localStorage.getItem('adh.token');
    const query = new URLSearchParams();
    if (token) query.set('token', token);
    if (version) query.set('v', String(version));
    const suffix = query.toString();
    return withBase(`/api/packages/${id}/icon${suffix ? `?${suffix}` : ''}`);
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
    return withBase(`/api/devices/${deviceId}/apps/export?${query.toString()}`);
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
    return withBase(`/api/devices/${deviceId}/apps/icon?${query.toString()}`);
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
      withBase(
        `/api/devices/${deviceId}/files/download?path=${encodeURIComponent(filePath)}`,
      ),
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
      withBase(
        `/api/devices/${deviceId}/files/upload?dir=${encodeURIComponent(dir)}`,
      ),
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

  /** 把图片快速导入 Android 设备相册（上传 / 剪贴板 / 截图）。 */
  async importDeviceGalleryImage(
    deviceId: string,
    blob: Blob,
    name: string,
  ): Promise<{ path: string; name: string }> {
    const response = await fetch(
      withBase(`/api/devices/${deviceId}/gallery/import`),
      {
        method: 'POST',
        headers: authHeaders({
          'content-type': 'application/octet-stream',
          'x-file-name': encodeURIComponent(name),
        }),
        body: blob,
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
    return (await response.json()) as { path: string; name: string };
  },

  /** 把图片推送到 iOS App 容器的 Documents / tmp（不经过相册）。 */
  async importDeviceAppFile(
    deviceId: string,
    blob: Blob,
    options: {
      bundleId: string;
      container: 'documents' | 'temp';
      name: string;
    },
  ): Promise<{ path: string; name: string; container: string }> {
    const query = new URLSearchParams({ container: options.container });
    if (options.bundleId) query.set('bundleId', options.bundleId);
    const response = await fetch(
      withBase(
        `/api/devices/${deviceId}/app-files/import?${query.toString()}`,
      ),
      {
        method: 'POST',
        headers: authHeaders({
          'content-type': 'application/octet-stream',
          'x-file-name': encodeURIComponent(options.name),
        }),
        body: blob,
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
    return (await response.json()) as {
      path: string;
      name: string;
      container: string;
    };
  },

  async downloadDeviceFilesZip(
    deviceId: string,
    paths: string[],
  ): Promise<Blob> {
    const response = await fetch(
      withBase(`/api/devices/${deviceId}/files/archive`),
      {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ paths }),
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
  return withBase(`/api/devices/${device.id}/thumbnail?${query.toString()}`);
}

