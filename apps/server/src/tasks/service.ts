import { randomUUID } from 'node:crypto';
import { BUILTIN_AGENT_ID, type DeviceSummary } from '@adh/protocol';
import type { CommandBus } from '../command-bus.js';
import type { SqlDriver } from '../db/driver.js';
import type { Queries } from '../db/queries.js';
import type { Logger } from '../log.js';
import type { AgentRegistry } from '../registry.js';
import type { SettingsService } from '../settings/service.js';
import type { StreamManager } from '../stream/manager.js';
import { runAiChat } from '../ai/service.js';
import type { AiHistoryStep } from '../ai/history.js';
import {
  extractLaunchTarget,
  isLaunchOnlyTask,
  launchAppByName,
} from '../ai/app-launch.js';
import { planBatchTasks, type BatchPlan } from './planner.js';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export interface TaskRecord {
  id: string;
  userId: string;
  deviceId: string | null;
  instruction: string;
  status: TaskStatus;
  reply: string;
  steps: AiHistoryStep[];
  error: string | null;
  createdAt: number;
  startedAt: number;
  finishedAt: number;
}

export interface CreateTaskInput {
  instruction: string;
  deviceId?: string;
  platform?: 'android' | 'ios';
  tags?: string[];
  timeoutSec?: number;
}

export interface CreateBatchTaskInput {
  deviceId: string;
  instruction: string;
  timeoutSec?: number;
}

export type BatchTaskMode = 'parallel' | 'sequential';

interface BatchItem {
  task: TaskRecord;
  device: DeviceSummary;
  timeoutSec?: number;
}

export interface TaskServiceDeps {
  db: SqlDriver;
  queries: Queries;
  registry: AgentRegistry;
  streams: StreamManager;
  commands: CommandBus;
  settings: SettingsService;
  logger: Logger;
}

const MAX_CONCURRENT_TASKS = 3;
const MAX_BATCH_TASKS = 20;
const DEFAULT_TIMEOUT_SEC = 600;

function normalizeInstruction(value: string): string {
  const instruction = value.trim();
  if (!instruction) throw new Error('任务描述不能为空');
  if (instruction.length > 2_000) throw new Error('任务描述不能超过 2000 字');
  return instruction;
}

interface TaskRow {
  id: string;
  userId: string;
  deviceId: string | null;
  instruction: string;
  status: string;
  reply: string | null;
  stepsJson: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number;
  finishedAt: number;
}

function toTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    userId: row.userId,
    deviceId: row.deviceId,
    instruction: row.instruction,
    status: row.status as TaskStatus,
    reply: row.reply ?? '',
    steps: parseSteps(row.stepsJson),
    error: row.error ?? null,
    createdAt: Number(row.createdAt) || 0,
    startedAt: Number(row.startedAt) || 0,
    finishedAt: Number(row.finishedAt) || 0,
  };
}

function parseSteps(raw: string | null): AiHistoryStep[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is AiHistoryStep =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as { name?: unknown }).name === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * 外部任务调度：找一台空闲设备，占用它，跑现有视觉闭环，最后落库。
 *
 * 任务不依赖 Web 控制者，内部会自己创建投屏会话；期间设备会加任务锁，
 * 普通 viewer 进不来，避免任务执行到一半被人工接管。
 */
export class TaskService {
  private readonly active = new Map<
    string,
    { deviceId: string; abort: AbortController }
  >();
  /** 批量创建后、尚未真正开始任务的设备，避免被单任务重复选中。 */
  private readonly reserved = new Set<string>();
  /** 排队中被取消的批量任务；轮到执行时直接跳过。 */
  private readonly cancelled = new Set<string>();

  constructor(private readonly deps: TaskServiceDeps) {}

  async create(
    user: { id: string; username: string },
    input: CreateTaskInput,
  ): Promise<TaskRecord> {
    const instruction = normalizeInstruction(input.instruction);
    if (this.active.size >= MAX_CONCURRENT_TASKS) {
      throw new Error(`当前最多同时执行 ${MAX_CONCURRENT_TASKS} 个任务，请稍后重试`);
    }

    const device = await this.pickDevice(input);
    const task = await this.insertTask(user, device, instruction);
    void this.run(task, device, input.timeoutSec);
    return task;
  }

  /**
   * 把一句自然语言拆成单台 / 多台任务（只做规划，不占用设备）。
   */
  async planBatch(input: {
    instruction: string;
    deviceIds?: string[];
  }): Promise<BatchPlan> {
    const instruction = normalizeInstruction(input.instruction);
    const settings = await this.deps.settings.getAiSettings();
    if (!settings.enabled) throw new Error('AI 助手未启用');
    if (!settings.apiKey || !settings.model) {
      throw new Error('AI 模型尚未配置');
    }

    const devices = (await this.deps.queries.listDevices()).filter(
      (device) => device.status === 'online' && !device.locked,
    );
    return planBatchTasks({
      settings,
      devices,
      selectedIds: input.deviceIds ?? [],
      instruction,
    });
  }

  /**
   * 批量任务：每台设备一条独立的 adh_tasks 记录。
   *
   * parallel 最多 3 台并发；sequential 按传入顺序执行，适合
   * “A 发消息给 B，B 收到后回复”这种有先后依赖的任务。
   */
  async createBatch(
    user: { id: string; username: string },
    inputs: CreateBatchTaskInput[],
    mode: BatchTaskMode = 'parallel',
  ): Promise<TaskRecord[]> {
    if (inputs.length === 0) throw new Error('批量任务不能为空');
    if (inputs.length > MAX_BATCH_TASKS) {
      throw new Error(`一次最多创建 ${MAX_BATCH_TASKS} 个批量任务`);
    }

    const devices = await this.deps.queries.listDevices();
    const taskBusy = new Set(
      [...this.active.values()].map((item) => item.deviceId),
    );
    const seen = new Set<string>();
    const prepared: Array<{
      device: DeviceSummary;
      instruction: string;
      timeoutSec?: number;
    }> = [];

    for (const input of inputs) {
      const instruction = normalizeInstruction(input.instruction);
      const device = devices.find((item) => item.id === input.deviceId);
      if (!device) throw new Error(`设备不存在：${input.deviceId}`);
      if (seen.has(device.id)) {
        throw new Error(`设备重复：${device.name}`);
      }
      if (!this.isAvailable(device, taskBusy)) {
        throw new Error(`设备当前不可用：${device.name}`);
      }
      // 批量页自己的预览会话会被任务复用；只拒绝其他用户正在控制的设备
      const control = this.deps.streams.getControl(device.id);
      if (control && control.userId !== user.id) {
        throw new Error(
          `设备正被 ${control.username} 使用：${device.name}`,
        );
      }
      seen.add(device.id);
      prepared.push({
        device,
        instruction,
        timeoutSec: input.timeoutSec,
      });
    }

    const items: BatchItem[] = [];
    try {
      for (const item of prepared) {
        const task = await this.insertTask(user, item.device, item.instruction);
        items.push({ ...item, task });
        this.reserved.add(item.device.id);
      }
    } catch (error) {
      for (const item of items) this.reserved.delete(item.device.id);
      throw error;
    }

    void this.runBatch(items, mode).catch((error) => {
      this.deps.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'batch task failed',
      );
    });
    return items.map((item) => item.task);
  }

  private async insertTask(
    user: { id: string },
    device: DeviceSummary,
    instruction: string,
  ): Promise<TaskRecord> {
    const now = Date.now();
    const task: TaskRecord = {
      id: randomUUID(),
      userId: user.id,
      deviceId: device.id,
      instruction,
      status: 'queued',
      reply: '',
      steps: [],
      error: null,
      createdAt: now,
      startedAt: 0,
      finishedAt: 0,
    };

    await this.deps.db.execute(
      `INSERT INTO adh_tasks
        (id, user_id, device_id, instruction, status, reply, steps_json, error,
         created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.userId,
        task.deviceId,
        task.instruction,
        task.status,
        task.reply,
        '[]',
        null,
        task.createdAt,
        0,
        0,
      ],
    );
    return task;
  }

  private async runBatch(
    items: BatchItem[],
    mode: BatchTaskMode,
  ): Promise<void> {
    if (mode === 'sequential') {
      for (const item of items) {
        try {
          await this.run(item.task, item.device, item.timeoutSec);
        } finally {
          this.reserved.delete(item.device.id);
        }
      }
      return;
    }

    const queue = [...items];
    const workerCount = Math.min(MAX_CONCURRENT_TASKS, queue.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        for (;;) {
          const item = queue.shift();
          if (!item) return;
          try {
            await this.run(item.task, item.device, item.timeoutSec);
          } finally {
            this.reserved.delete(item.device.id);
          }
        }
      }),
    );
  }

  private isAvailable(
    device: DeviceSummary,
    taskBusy: Set<string>,
  ): boolean {
    if (device.status !== 'online' || device.locked) return false;
    if (
      device.agentId !== BUILTIN_AGENT_ID &&
      !this.deps.registry.isOnline(device.agentId)
    ) {
      return false;
    }
    if (taskBusy.has(device.id) || this.reserved.has(device.id)) {
      return false;
    }
    return true;
  }

  async get(userId: string, id: string): Promise<TaskRecord | null> {
    const [row] = await this.deps.db.query<TaskRow>(
      `SELECT id, user_id AS userId, device_id AS deviceId, instruction,
              status, reply, steps_json AS stepsJson, error,
              created_at AS createdAt, started_at AS startedAt,
              finished_at AS finishedAt
       FROM adh_tasks
       WHERE id = ? AND user_id = ?`,
      [id, userId],
    );
    return row ? toTask(row) : null;
  }

  async list(userId: string, limit = 20): Promise<TaskRecord[]> {
    const rows = await this.deps.db.query<TaskRow>(
      `SELECT id, user_id AS userId, device_id AS deviceId, instruction,
              status, reply, steps_json AS stepsJson, error,
              created_at AS createdAt, started_at AS startedAt,
              finished_at AS finishedAt
       FROM adh_tasks
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ${Math.min(100, Math.max(1, limit))}`,
      [userId],
    );
    return rows.map(toTask);
  }

  async cancel(userId: string, id: string): Promise<boolean> {
    const task = await this.get(userId, id);
    if (!task) return false;
    if (task.status !== 'queued' && task.status !== 'running') return false;

    const run = this.active.get(id);
    run?.abort.abort();

    if (task.status === 'queued') {
      this.cancelled.add(task.id);
      if (task.deviceId) this.reserved.delete(task.deviceId);
      task.status = 'cancelled';
      task.finishedAt = Date.now();
      await this.save(task);
    }
    return true;
  }

  private async pickDevice(input: CreateTaskInput): Promise<DeviceSummary> {
    const devices = await this.deps.queries.listDevices();
    const inUse = new Set(this.deps.streams.listInUseDeviceIds());
    const taskBusy = new Set(
      [...this.active.values()].map((item) => item.deviceId),
    );

    const candidates = devices
      .filter((device) => {
        if (device.status !== 'online' || device.locked) return false;
        if (
          device.agentId !== BUILTIN_AGENT_ID &&
          !this.deps.registry.isOnline(device.agentId)
        ) {
          return false;
        }
        if (inUse.has(device.id) || taskBusy.has(device.id)) return false;
        if (this.reserved.has(device.id)) return false;
        if (input.deviceId && device.id !== input.deviceId) return false;
        if (input.platform && device.platform !== input.platform) return false;
        if (
          input.tags?.length &&
          !input.tags.every((tag) => device.tags.includes(tag))
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        // 优先用闲置最久、使用次数最少的设备
        const used = a.useCount - b.useCount;
        if (used !== 0) return used;
        return a.lastUsedAt - b.lastUsedAt;
      });

    const device = candidates[0];
    if (!device) {
      throw new Error(
        input.deviceId
          ? '指定设备当前不可用（离线、被锁定或正在使用）'
          : '没有空闲设备，请稍后重试',
      );
    }
    return device;
  }

  /**
   * 批量任务只负责入队；真正执行前等待全局并发槽位，
   * 避免和现有单任务叠加后超过 MAX_CONCURRENT_TASKS。
   */
  private async waitForTaskSlot(): Promise<void> {
    while (this.active.size >= MAX_CONCURRENT_TASKS) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  private async run(
    task: TaskRecord,
    device: DeviceSummary,
    timeoutSec?: number,
  ): Promise<void> {
    // 排队期间被取消的批量任务，轮到执行时不再启动
    if (this.cancelled.has(task.id)) {
      this.cancelled.delete(task.id);
      task.status = 'cancelled';
      task.finishedAt = Date.now();
      await this.save(task);
      return;
    }

    await this.waitForTaskSlot();
    if (this.cancelled.has(task.id)) {
      this.cancelled.delete(task.id);
      task.status = 'cancelled';
      task.finishedAt = Date.now();
      await this.save(task);
      return;
    }

    const abort = new AbortController();
    const timeoutMs =
      Math.min(1_800, Math.max(30, timeoutSec ?? DEFAULT_TIMEOUT_SEC)) * 1_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, timeoutMs);

    this.active.set(task.id, { deviceId: device.id, abort });
    this.deps.streams.lockForTask(device.id);

    task.status = 'running';
    task.startedAt = Date.now();
    await this.save(task);

    let sessionId: string | null = null;
    let ownsSession = false;
    try {
      // 只是“打开某个 App”的任务：直接走应用启动快速通道，
      // 不建投屏会话、不调视觉模型。
      const launchTarget = extractLaunchTarget(task.instruction);
      if (launchTarget && isLaunchOnlyTask(task.instruction)) {
        try {
          const launchStart = Date.now();
          const launched = await launchAppByName({
            device,
            name: launchTarget,
            commands: this.deps.commands,
            logger: this.deps.logger,
          });
          if (launched?.trusted) {
            this.deps.logger.info(
              {
                taskId: task.id,
                deviceId: device.id,
                name: launchTarget,
                packageName: launched.packageName,
                method: launched.method,
                ms: Date.now() - launchStart,
              },
              'ai task fast launch',
            );
            task.status = 'succeeded';
            task.reply = `已打开 ${launchTarget}`;
            task.steps = [
              {
                name: 'launch_app',
                args: {
                  name: launchTarget,
                  ...(launched.packageName
                    ? { package: launched.packageName }
                    : {}),
                },
                detail: `已启动 ${launchTarget}`,
                ok: true,
              },
            ];
            task.finishedAt = Date.now();
            await this.save(task);
            return;
          }
        } catch (error) {
          this.deps.logger.warn(
            {
              taskId: task.id,
              deviceId: device.id,
              name: launchTarget,
              err: String(error),
            },
            'ai task fast launch failed',
          );
        }
      }

      // 内置 iOS 直接走 WDA，不需要投屏会话；其余设备都先建会话
      const needsSession = !(
        device.platform === 'ios' && device.agentId === BUILTIN_AGENT_ID
      );
      if (needsSession) {
        const readyStart = Date.now();
        const created = await this.deps.streams.create(device.id, 'medium');
        sessionId = created.sessionId;
        ownsSession = !created.reused;
        const ready = await this.deps.streams.waitReady(device.id, 15_000);
        if (!ready) throw new Error('设备投屏会话未就绪');
        this.deps.logger.info(
          { taskId: task.id, deviceId: device.id, ms: Date.now() - readyStart },
          'ai task stream ready',
        );
      }

      const steps: AiHistoryStep[] = [];
      let reply = '';
      await runAiChat(
        {
          settings: this.deps.settings,
          streams: this.deps.streams,
          commands: this.deps.commands,
          logger: this.deps.logger,
        },
        {
          device,
          messages: [{ role: 'user', content: task.instruction }],
          signal: abort.signal,
          onEvent: (event) => {
            if (event.type === 'tool') {
              steps.push({ name: event.name, args: event.args });
              task.steps = steps;
              // 运行中持续落库，MCP 轮询 get_task 能看到当前进度
              void this.save(task);
              return;
            }
            if (event.type === 'tool_result') {
              const last = steps[steps.length - 1];
              if (
                last &&
                last.name === event.name &&
                last.detail === undefined
              ) {
                last.detail = event.detail;
                last.ok = event.ok;
              }
              task.steps = steps;
              void this.save(task);
              return;
            }
            if (event.type === 'reply') {
              reply = event.content;
              task.reply = reply;
              task.steps = steps;
              void this.save(task);
            }
          },
        },
      );

      task.status = 'succeeded';
      task.reply = reply;
      task.steps = steps;
      task.finishedAt = Date.now();
      await this.save(task);
    } catch (error) {
      task.error = error instanceof Error ? error.message : String(error);
      task.status = timedOut
        ? 'timeout'
        : abort.signal.aborted
          ? 'cancelled'
          : 'failed';
      task.finishedAt = Date.now();
      await this.save(task);
      if (!abort.signal.aborted) {
        this.deps.logger.warn(
          { taskId: task.id, deviceId: device.id, err: task.error },
          'ai task failed',
        );
      }
    } finally {
      clearTimeout(timer);
      if (sessionId && ownsSession) {
        this.deps.streams.destroy(sessionId, 'AI 任务结束');
      }
      this.deps.streams.unlockForTask(device.id);
      this.active.delete(task.id);
    }
  }

  /** 串行写任务状态，避免运行中快速更新时旧快照覆盖新快照。 */
  private saveChain: Promise<void> = Promise.resolve();

  private save(task: TaskRecord): Promise<void> {
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(() => this.writeTask(task));
    return this.saveChain;
  }

  private async writeTask(task: TaskRecord): Promise<void> {
    await this.deps.db.execute(
      `UPDATE adh_tasks SET
        status = ?, reply = ?, steps_json = ?, error = ?,
        started_at = ?, finished_at = ?
       WHERE id = ?`,
      [
        task.status,
        task.reply,
        JSON.stringify(task.steps),
        task.error,
        task.startedAt,
        task.finishedAt,
        task.id,
      ],
    );
  }
}