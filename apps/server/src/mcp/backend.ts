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
  control: {
    userId: string;
    username: string;
    displayName?: string;
    since: number;
  } | null;
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

/** 把任务上的回放 token 转成可直接打开的分享链接。 */
function withReplayUrl(task: unknown, baseUrl: string): unknown {
  if (!task || typeof task !== 'object') return task;
  const record = task as Record<string, unknown>;
  const token = record.replayToken;
  if (typeof token !== 'string' || !token) return task;
  const rest = { ...record };
  delete rest.replayToken;
  return {
    ...rest,
    replayUrl: `${baseUrl.replace(/\/+$/, '')}/r/${token}`,
  };
}

/** 进程内直接调用 service，供 `/mcp` 使用。 */
export function createLocalBackend(
  deps: LocalBackendDeps,
  user: AuthUser,
  publicBaseUrl = '',
): McpBackend {
  const replay = (task: unknown): unknown => withReplayUrl(task, publicBaseUrl);

  return {
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

/** 通过 HTTP 调用平台 API，供 stdio MCP 使用。 */
export function createHttpBackend(options: HttpBackendOptions): McpBackend {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  async function call<T>(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        ...(init?.body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });

    const text = await response.text();
    if (!response.ok) {
      let message = `ADH API ${response.status}`;
      try {
        const parsed = JSON.parse(text) as ApiError;
        if (parsed.error) message = parsed.error;
      } catch {
        if (text) message = text.slice(0, 500);
      }
      throw new Error(message);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  return {
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
  };
}