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

/**
 * MCP 工具的执行后端。
 *
 * stdio 模式通过 HTTP 调自己的 API；Streamable HTTP 模式直接调用进程内
 * service，省掉一次本机回环请求，也避免依赖对外地址。
 */
export interface McpBackend {
  listDevices(input: ListDevicesInput): Promise<McpDevice[]>;
  runTask(input: CreateTaskInput): Promise<unknown>;
  getTask(taskId: string): Promise<unknown | null>;
  listTasks(limit?: number): Promise<unknown[]>;
  cancelTask(taskId: string): Promise<unknown>;
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

/** 进程内直接调用 service，供 `/mcp` 使用。 */
export function createLocalBackend(
  deps: LocalBackendDeps,
  user: AuthUser,
): McpBackend {
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

    runTask(input) {
      return deps.tasks.create(user, input);
    },

    getTask(taskId) {
      return deps.tasks.get(user.id, taskId);
    },

    listTasks(limit) {
      return deps.tasks.list(user.id, limit ?? 20);
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

    async runTask(input) {
      const result = await call<{ task: unknown }>('/api/tasks', {
        method: 'POST',
        body: input,
      });
      return result.task;
    },

    async getTask(taskId) {
      const result = await call<{ task: unknown }>(
        `/api/tasks/${encodeURIComponent(taskId)}`,
      );
      return result.task;
    },

    async listTasks(limit) {
      const result = await call<{ tasks: unknown[] }>(
        `/api/tasks?limit=${Math.min(50, Math.max(1, limit ?? 20))}`,
      );
      return result.tasks;
    },

    cancelTask(taskId) {
      return call(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
        method: 'POST',
      });
    },
  };
}