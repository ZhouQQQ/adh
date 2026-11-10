import { BUILTIN_AGENT_ID } from '@adh/protocol';
import type { AuthUser } from '../auth/service.js';
import type { Queries } from '../db/queries.js';
import type { AgentRegistry } from '../registry.js';
import type { StreamManager } from '../stream/manager.js';
import type { CreateTaskInput, TaskService } from '../tasks/service.js';

/** MCP 工具看到的设备视图，字段比 DeviceSummary 更精简。 */
export interface McpDevice {
  id: string;
  name: string;
  platform: string;
  status: string;
  tags: string[];
  osVersion?: string;
  idle: boolean;
}

export interface ListDevicesInput {
  platform?: 'android' | 'ios';
  tags?: string[];
  idleOnly?: boolean;
}

/** 单台设备的详细信息，供 MCP 的 get_device 使用。 */
export interface McpDeviceDetail extends McpDevice {
  udid: string;
  agentId: string;
  model?: string;
  marketName?: string;
  brand?: string;
  resolution?: { width: number; height: number };
  locked: boolean;
  /** Web 控制页地址，任务执行中打开即只读观看。 */
  watchUrl?: string;
  control: {
    userId: string;
    username: string;
    displayName?: string;
    since: number;
  } | null;
}

/** 节点（宿主机 Agent / 设备直连）。 */
export interface McpAgent {
  id: string;
  name: string;
  kind: 'host' | 'portal';
  online: boolean;
  os: string;
  version: string;
  capabilities: string[];
  deviceCount: number;
  /** 直连节点的连接账号，仅用于说明是谁连的，不影响管理权限。 */
  ownerUsername?: string;
}

/** 应用库里的安装包（APK / IPA）。 */
export interface McpPackage {
  id: string;
  name: string;
  kind: string;
  size: number;
  uploadedAt: number;
  remark?: string | null;
  tags?: string[];
}

/** 设备上已安装的应用。 */
export interface McpApp {
  name: string;
  version?: string | null;
  size?: number | null;
}

export interface McpScreenshot {
  mimeType: string;
  base64: string;
}

/** 实时观看信息：控制页链接 + 当前会话状态。 */
export interface McpWatchInfo {
  deviceId: string;
  watchUrl: string;
  sessionId?: string;
  reused?: boolean;
  /** 设备正在被 AI 任务占用时，打开页面只能只读观看。 */
  readOnly?: boolean;
  aiTask?: unknown;
}

export interface McpInstallResult {
  deviceId: string;
  deviceName?: string;
  ok: boolean;
  error?: string;
}

/** JSON + 二进制两种调用方式，两种 transport 共用同一套工具实现。 */
interface RestTransport {
  json<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  binary(path: string): Promise<{ data: Buffer; mimeType: string }>;
}

/**
 * MCP 工具的执行后端。
 *
 * stdio 模式通过 HTTP 调自己的 API；Streamable HTTP 模式直接调用进程内
 * service，省掉一次本机回环请求，也避免依赖对外地址。
 */
export interface McpBackend {
  listDevices(input: ListDevicesInput): Promise<McpDevice[]>;
  getDevice(deviceId: string): Promise<McpDeviceDetail | null>;
  runTask(input: CreateTaskInput): Promise<unknown>;
  batchTask(input: {
    instruction: string;
    deviceIds?: string[];
  }): Promise<unknown>;
  getTask(taskId: string): Promise<unknown | null>;
  listTasks(limit?: number): Promise<unknown[]>;
  cancelTask(taskId: string): Promise<unknown>;
  cancelAllTasks(): Promise<{ ok: boolean; count: number }>;
  listAgents(): Promise<McpAgent[]>;
  listPackages(): Promise<McpPackage[]>;
  installApp(input: {
    deviceIds: string[];
    packageId: string;
  }): Promise<McpInstallResult[]>;
  listDeviceApps(deviceId: string): Promise<McpApp[]>;
  uninstallApp(input: {
    deviceId: string;
    packageName: string;
  }): Promise<{ ok: boolean }>;
  launchApp(input: {
    deviceId: string;
    packageName: string;
  }): Promise<{ ok: boolean }>;
  screenshot(deviceId: string): Promise<McpScreenshot>;
  watchDevice(deviceId: string): Promise<McpWatchInfo>;
  /** Web 控制页地址，设备类工具统一带上，调用方不用再多问一次。 */
  controlUrl(deviceId: string): string | undefined;
  setDeviceLock(input: {
    deviceId: string;
    locked: boolean;
  }): Promise<unknown>;
}

export interface LocalBackendDeps {
  queries: Queries;
  registry: AgentRegistry;
  streams: StreamManager;
  tasks: TaskService;
}

function filterDevices(
  devices: McpDevice[],
  input: ListDevicesInput,
): McpDevice[] {
  const onlyIdle = input.idleOnly !== false;
  return devices.filter((device) => {
    if (input.platform && device.platform !== input.platform) return false;
    if (
      input.tags?.length &&
      !input.tags.every((tag) => device.tags.includes(tag))
    ) {
      return false;
    }
    if (onlyIdle && !device.idle) return false;
    return true;
  });
}

/** Web 控制页地址（实时画面）。 */
function watchUrlFor(baseUrl: string, deviceId: string): string | undefined {
  const root = baseUrl.replace(/\/+$/, '');
  if (!root) return undefined;
  return `${root}/devices/${encodeURIComponent(deviceId)}/control`;
}

/** 任务附带两个可直接发给人的链接：执行过程回放，以及设备实时控制页。 */
function withReplayUrl(task: unknown, baseUrl: string): unknown {
  if (!task || typeof task !== 'object') return task;
  const root = baseUrl.replace(/\/+$/, '');
  const record = task as Record<string, unknown>;
  const token = record.replayToken;
  const deviceId = typeof record.deviceId === 'string' ? record.deviceId : '';

  const rest = { ...record };
  delete rest.replayToken;
  return {
    ...rest,
    ...(typeof token === 'string' && token
      ? { replayUrl: `${root}/r/${token}` }
      : {}),
    // 实时画面：任务执行中打开是只读观看，任务结束后就是正常控制页
    ...(deviceId
      ? { watchUrl: `${root}/devices/${encodeURIComponent(deviceId)}/control` }
      : {}),
  };
}

/**
 * 安装、应用列表、截图、节点列表这些能力都走平台自己的 REST 接口，
 * 两种 MCP transport 共用同一份实现，避免逻辑走样。
 */
function createRestTools(
  transport: RestTransport,
  baseUrl: string,
): Pick<
  McpBackend,
  | 'listAgents'
  | 'listPackages'
  | 'installApp'
  | 'listDeviceApps'
  | 'uninstallApp'
  | 'launchApp'
  | 'screenshot'
  | 'watchDevice'
  | 'setDeviceLock'
> {
  const root = baseUrl.replace(/\/+$/, '');
  const watchUrlOf = (deviceId: string): string =>
    `${root}/devices/${encodeURIComponent(deviceId)}/control`;

  return {
    async listAgents() {
      const agents = await transport.json<
        Array<{
          id: string;
          name: string;
          kind?: 'host' | 'portal';
          online?: boolean;
          os?: string;
          version?: string;
          capabilities?: string[];
          deviceCount?: number;
          ownerUsername?: string;
        }>
      >('/api/agents');
      return agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        kind: agent.kind === 'portal' ? 'portal' : 'host',
        online: Boolean(agent.online),
        os: agent.os ?? '',
        version: agent.version ?? '',
        capabilities: agent.capabilities ?? [],
        deviceCount: agent.deviceCount ?? 0,
        ownerUsername: agent.ownerUsername,
      }));
    },

    async listPackages() {
      const result = await transport.json<{ packages: McpPackage[] }>(
        '/api/packages',
      );
      return result.packages.map((item) => ({
        id: item.id,
        name: item.name,
        kind: item.kind,
        size: item.size,
        uploadedAt: item.uploadedAt,
        remark: item.remark ?? null,
        tags: item.tags ?? [],
      }));
    },

    async installApp(input) {
      const results: McpInstallResult[] = [];
      for (const deviceId of input.deviceIds) {
        try {
          await transport.json(
            `/api/devices/${encodeURIComponent(deviceId)}/install`,
            { method: 'POST', body: { packageId: input.packageId } },
          );
          results.push({ deviceId, ok: true });
        } catch (error) {
          results.push({
            deviceId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return results;
    },

    async listDeviceApps(deviceId) {
      const result = await transport.json<{ packages: McpApp[] }>(
        `/api/devices/${encodeURIComponent(deviceId)}/apps`,
      );
      return result.packages.map((item) => ({
        name: item.name,
        version: item.version ?? null,
        size: item.size ?? null,
      }));
    },

    uninstallApp(input) {
      return transport.json<{ ok: boolean }>(
        `/api/devices/${encodeURIComponent(input.deviceId)}/apps/uninstall`,
        { method: 'POST', body: { package: input.packageName } },
      );
    },

    launchApp(input) {
      return transport.json<{ ok: boolean }>(
        `/api/devices/${encodeURIComponent(input.deviceId)}/apps/launch`,
        { method: 'POST', body: { package: input.packageName } },
      );
    },

    async screenshot(deviceId) {
      const { data, mimeType } = await transport.binary(
        `/api/devices/${encodeURIComponent(deviceId)}/screenshot`,
      );
      return { mimeType, base64: data.toString('base64') };
    },

    /**
     * 打开一台设备的实时画面：先确保投屏会话存在（复用任务自己的会话），
     * 再返回 Web 控制页链接，其他人打开就能看到任务执行过程。
     */
    async watchDevice(deviceId) {
      const watchUrl = watchUrlOf(deviceId);
      try {
        const session = await transport.json<{
          sessionId?: string;
          reused?: boolean;
          readOnly?: boolean;
          aiTask?: unknown;
        }>(`/api/devices/${encodeURIComponent(deviceId)}/stream`, {
          method: 'POST',
          body: {},
        });
        return {
          deviceId,
          watchUrl,
          sessionId: session.sessionId,
          reused: session.reused,
          readOnly: session.readOnly,
          aiTask: session.aiTask,
        };
      } catch {
        // 本机 iOS 走 WDA 直连，没有投屏会话；控制页依然可以直接打开
        return { deviceId, watchUrl };
      }
    },

    setDeviceLock(input) {
      return transport.json(
        `/api/devices/${encodeURIComponent(input.deviceId)}`,
        { method: 'PATCH', body: { locked: input.locked } },
      );
    },
  };
}

/** 进程内直接调用 service，供 `/mcp` 使用。 */
export function createLocalBackend(
  deps: LocalBackendDeps,
  user: AuthUser,
  publicBaseUrl = '',
  apiToken = '',
): McpBackend {
  const replay = (task: unknown): unknown => withReplayUrl(task, publicBaseUrl);
  // 安装 / 截图 / 应用列表这类动作复用平台 REST，内部回环一次即可；
  // 拿不到站点地址或 token 时给出明确报错，而不是静默失败。
  const transport: RestTransport =
    publicBaseUrl && apiToken
      ? createFetchTransport(publicBaseUrl, apiToken)
      : {
          async json() {
            throw new Error('该工具需要访问平台 REST 接口，当前请求缺少站点地址');
          },
          async binary() {
            throw new Error('该工具需要访问平台 REST 接口，当前请求缺少站点地址');
          },
        };

  return {
    ...createRestTools(transport, publicBaseUrl),
    controlUrl(deviceId) {
      return watchUrlFor(publicBaseUrl, deviceId);
    },
    async listDevices(input) {
      const [devices, inUseIds] = await Promise.all([
        deps.queries.listDevices(),
        Promise.resolve(deps.streams.listInUseDeviceIds()),
      ]);
      const inUse = new Set(inUseIds);
      const mapped: McpDevice[] = devices.map((device) => {
        const agentOnline =
          device.agentId === BUILTIN_AGENT_ID ||
          deps.registry.isOnline(device.agentId);
        const online = device.status === 'online' && agentOnline;
        return {
          id: device.id,
          name: device.name,
          platform: device.platform,
          status: online ? 'online' : 'offline',
          tags: device.tags ?? [],
          osVersion: device.osVersion,
          idle: online && !device.locked && !inUse.has(device.id),
        };
      });
      return filterDevices(mapped, input);
    },

    async getDevice(deviceId) {
      const device = await deps.queries.getDevice(deviceId);
      if (!device) return null;
      const agentOnline =
        device.agentId === BUILTIN_AGENT_ID ||
        deps.registry.isOnline(device.agentId);
      const online = device.status === 'online' && agentOnline;
      const control = deps.streams.getControl(deviceId);
      return {
        id: device.id,
        name: device.name,
        platform: device.platform,
        status: online ? 'online' : 'offline',
        tags: device.tags ?? [],
        osVersion: device.osVersion,
        idle: online && !device.locked && !control,
        udid: device.udid,
        agentId: device.agentId,
        model: device.model ?? undefined,
        marketName: device.marketName ?? undefined,
        brand: device.brand ?? undefined,
        resolution: device.resolution,
        locked: Boolean(device.locked),
        watchUrl: watchUrlFor(publicBaseUrl, deviceId),
        control: control
          ? {
              userId: control.userId,
              username: control.username,
              displayName: control.displayName,
              since: control.since,
            }
          : null,
      };
    },

    async runTask(input) {
      return replay(await deps.tasks.create(user, input));
    },

    async batchTask(input) {
      const plan = await deps.tasks.planBatch({
        instruction: input.instruction,
        deviceIds: input.deviceIds,
      });
      if (plan.scope === 'none' || plan.tasks.length === 0) {
        return { scope: plan.scope, summary: plan.summary, tasks: [] };
      }
      const tasks = await deps.tasks.createBatch(user, plan.tasks, plan.mode);
      return {
        scope: plan.scope,
        mode: plan.mode,
        summary: plan.summary,
        tasks: tasks.map(replay),
      };
    },

    async getTask(taskId) {
      const task = await deps.tasks.get(user.id, taskId);
      return task ? replay(task) : null;
    },

    async listTasks(limit) {
      const tasks = await deps.tasks.list(user.id, limit ?? 20);
      return tasks.map(replay);
    },

    async cancelTask(taskId) {
      const task = await deps.tasks.get(user.id, taskId);
      if (!task) throw new Error('任务不存在');
      if (task.status !== 'queued' && task.status !== 'running') {
        throw new Error('任务已经结束');
      }
      await deps.tasks.cancel(user.id, taskId);
      return { ok: true };
    },

    async cancelAllTasks() {
      const count = await deps.tasks.cancelPending(user.id);
      return { ok: true, count };
    },
  };
}

interface ApiError {
  error?: string;
}

export interface HttpBackendOptions {
  /** 含部署前缀，例如 http://127.0.0.1:8080/adh */
  baseUrl: string;
  apiKey: string;
}

/** 用 API Key（或登录 token）访问平台 REST 接口。 */
function createFetchTransport(baseUrl: string, token: string): RestTransport {
  const root = baseUrl.replace(/\/+$/, '');

  async function request(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<Response> {
    const response = await fetch(`${root}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(init?.body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (response.ok) return response;

    const raw = await response.text();
    let message = `ADH API ${response.status}`;
    try {
      const parsed = JSON.parse(raw) as ApiError;
      if (parsed.error) message = parsed.error;
    } catch {
      if (raw) message = raw.slice(0, 500);
    }
    throw new Error(message);
  }

  return {
    async json<T>(
      path: string,
      init?: { method?: string; body?: unknown },
    ) {
      const response = await request(path, init);
      const raw = await response.text();
      return (raw ? JSON.parse(raw) : {}) as T;
    },
    async binary(path: string) {
      const response = await request(path);
      const data = Buffer.from(await response.arrayBuffer());
      return {
        data,
        mimeType: response.headers.get('content-type') ?? 'image/png',
      };
    },
  };
}

/** 通过 HTTP 调用平台 API，供 stdio MCP 使用。 */
export function createHttpBackend(options: HttpBackendOptions): McpBackend {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const transport = createFetchTransport(options.baseUrl, options.apiKey);
  const call = transport.json;

  return {
    controlUrl(deviceId) {
      return watchUrlFor(baseUrl, deviceId);
    },
    async listDevices(input) {
      const devices = await call<
        Array<{
          id: string;
          name: string;
          platform: string;
          status: string;
          tags?: string[];
          osVersion?: string;
          locked?: boolean;
          inUse?: boolean;
        }>
      >('/api/devices');

      return filterDevices(
        devices.map((device) => ({
          id: device.id,
          name: device.name,
          platform: device.platform,
          status: device.status,
          tags: device.tags ?? [],
          osVersion: device.osVersion,
          idle:
            device.status === 'online' && !device.locked && !device.inUse,
        })),
        input,
      );
    },

    async getDevice(deviceId) {
      const device = await call<{
        id: string;
        name: string;
        platform: string;
        status: string;
        tags?: string[];
        osVersion?: string;
        udid: string;
        agentId: string;
        model?: string;
        marketName?: string;
        brand?: string;
        resolution?: { width: number; height: number };
        locked?: boolean;
        inUse?: boolean;
        control?: {
          userId: string;
          username: string;
          displayName?: string;
          since: number;
        } | null;
      }>(`/api/devices/${encodeURIComponent(deviceId)}`);

      return {
        id: device.id,
        name: device.name,
        platform: device.platform,
        status: device.status,
        tags: device.tags ?? [],
        osVersion: device.osVersion,
        idle: device.status === 'online' && !device.locked && !device.inUse,
        udid: device.udid,
        agentId: device.agentId,
        model: device.model,
        marketName: device.marketName,
        brand: device.brand,
        resolution: device.resolution,
        locked: Boolean(device.locked),
        watchUrl: watchUrlFor(baseUrl, deviceId),
        control: device.control ?? null,
      };
    },

    async batchTask(input) {
      const plan = await call<{
        plan: {
          scope: 'single' | 'batch' | 'none';
          mode: 'parallel' | 'sequential';
          summary: string;
          tasks: Array<{ deviceId: string; instruction: string }>;
        };
      }>('/api/tasks/batch/plan', {
        method: 'POST',
        body: { instruction: input.instruction, deviceIds: input.deviceIds },
      });

      if (plan.plan.scope === 'none' || plan.plan.tasks.length === 0) {
        return { ...plan.plan, tasks: [] };
      }

      const created = await call<{ tasks: unknown[] }>('/api/tasks/batch', {
        method: 'POST',
        body: { tasks: plan.plan.tasks, mode: plan.plan.mode },
      });
      return {
        ...plan.plan,
        tasks: created.tasks.map((task) => withReplayUrl(task, baseUrl)),
      };
    },

    async cancelAllTasks() {
      return call<{ ok: boolean; count: number }>('/api/tasks/cancel-pending', {
        method: 'POST',
        body: {},
      });
    },

    async runTask(input) {
      const result = await call<{ task: unknown }>('/api/tasks', {
        method: 'POST',
        body: input,
      });
      return withReplayUrl(result.task, baseUrl);
    },

    async getTask(taskId) {
      const result = await call<{ task: unknown }>(
        `/api/tasks/${encodeURIComponent(taskId)}`,
      );
      return withReplayUrl(result.task, baseUrl);
    },

    async listTasks(limit) {
      const result = await call<{ tasks: unknown[] }>(
        `/api/tasks?limit=${Math.min(50, Math.max(1, limit ?? 20))}`,
      );
      return result.tasks.map((task) => withReplayUrl(task, baseUrl));
    },

    cancelTask(taskId) {
      return call(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
        method: 'POST',
      });
    },
    ...createRestTools(transport, baseUrl),
  };
}