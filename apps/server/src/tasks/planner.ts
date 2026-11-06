import type { DeviceSummary } from '@adh/protocol';
import { chatCompletion } from '../ai/client.js';
import type { AiSettings } from '../settings/service.js';

export type BatchPlanScope = 'single' | 'batch' | 'none';

export interface BatchPlanTask {
  deviceId: string;
  instruction: string;
}

export interface BatchPlan {
  scope: BatchPlanScope;
  mode: 'parallel' | 'sequential';
  summary: string;
  tasks: BatchPlanTask[];
}

export interface PlanBatchOptions {
  settings: AiSettings;
  /** 可作为目标的在线设备。 */
  devices: DeviceSummary[];
  /** 批量控制页当前选中的设备，用于消解“这些 / 一起”等指代。 */
  selectedIds: string[];
  instruction: string;
  signal?: AbortSignal;
}

function deviceLine(device: DeviceSummary, selected: Set<string>): string {
  const bits = [
    `id=${device.id}`,
    `name=${device.name}`,
    `platform=${device.platform}`,
    selected.has(device.id) ? '当前选中' : '未选中',
  ];
  return `- ${bits.join(' | ')}`;
}

function extractJson(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return '';
  return text.slice(start, end + 1);
}

/**
 * 让模型把一句话拆成单台 / 多台任务。
 * 只做文本规划，不碰设备；真正的设备占用和视觉闭环仍走 TaskService。
 */
export async function planBatchTasks(
  options: PlanBatchOptions,
): Promise<BatchPlan> {
  const selected = new Set(options.selectedIds);
  const devices = options.devices;
  if (devices.length === 0) throw new Error('当前没有在线设备');

  const systemPrompt = `你是设备农场的任务分发器。用户会用一句自然语言描述要在 Android / iOS 设备上做的事，你需要判断是单台还是多台，并拆成每台设备可独立执行的完整指令。

## 只能使用下面列出的设备
${devices.map((device) => deviceLine(device, selected)).join('\n')}

## 判断规则
- 用户明确只针对一台设备（“只让”“单独”“用 Redmi K30 Pro”等）→ scope=single，tasks 只有一条。
- 用户说“一起 / 都 / 所有 / 每台 / 批量 / 这几台”或点名多台设备 → scope=batch。
- 用户用 A、B 指代设备时，按“当前选中设备”的列表顺序映射 A、B。
- 如果指令有先后依赖（A 发消息、B 再回复），mode=sequential，tasks 按执行顺序排列。
- 如果多台设备做同一件事、互不依赖，mode=parallel；每台设备仍然单独一条 task。
- 如果语义模糊且当前选中多台，默认 scope=batch、mode=parallel，对当前选中设备执行。
- 如果用户只是在问问题、没有可执行的设备操作，scope=none、tasks 为空。
- 每条 instruction 必须自包含：写清楚要打开什么、输入什么、发给谁、回复什么，不能只写“继续”“同上”。
- 绝不能编造 deviceId，也不能使用列表外的设备。

## 安全规则
- 涉及多台设备的破坏性 / 不可逆操作，不得拆成任务自动执行，包括但不限于：批量关机 / 重启、恢复出厂设置、清空数据、卸载系统应用、删除文件、群发消息、支付 / 转账。
- 遇到这类指令一律返回 scope=none、tasks=[]，并在 summary 中说明「该操作风险过高，AI 批量任务不会执行，需要人工确认或使用专门的管理入口」。
- 单台设备的普通操作可以正常规划。

## 输出
只输出 JSON，不要 Markdown 代码块，不要解释：
{"scope":"single|batch|none","mode":"parallel|sequential","summary":"中文一句话说明你的判断","tasks":[{"deviceId":"列表里的 id","instruction":"完整任务"}]}`;

  const result = await chatCompletion(
    options.settings,
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: options.instruction },
    ],
    [],
    options.signal,
    // 最多 20 台设备，1024 token 容易截断 JSON
    { maxTokens: 2048 },
  );

  const json = extractJson(result.content);
  if (!json) throw new Error('AI 没有返回可解析的任务编排');

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('AI 返回的任务编排不是合法 JSON');
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('AI 返回的任务编排格式不正确');
  }
  const data = raw as Record<string, unknown>;
  const scope =
    data.scope === 'single' || data.scope === 'batch' || data.scope === 'none'
      ? data.scope
      : 'batch';
  const mode = data.mode === 'sequential' ? 'sequential' : 'parallel';
  const summary =
    typeof data.summary === 'string' && data.summary.trim()
      ? data.summary.trim()
      : '已生成任务';

  if (scope === 'none') {
    return { scope, mode, summary, tasks: [] };
  }

  const allowed = new Map(devices.map((device) => [device.id, device]));
  const byName = new Map(devices.map((device) => [device.name, device]));
  const sourceTasks = Array.isArray(data.tasks) ? data.tasks : [];
  const tasks: BatchPlanTask[] = [];
  const seen = new Set<string>();
  for (const item of sourceTasks) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const rawDeviceId =
      typeof record.deviceId === 'string' ? record.deviceId.trim() : '';
    const instruction =
      typeof record.instruction === 'string' ? record.instruction.trim() : '';
    // 模型偶尔会把设备名当 id 返回，按名称兜底映射一次
    const device = allowed.get(rawDeviceId) ?? byName.get(rawDeviceId);
    if (!device || !instruction) continue;
    if (seen.has(device.id)) continue;
    if (instruction.length > 2_000) continue;
    seen.add(device.id);
    tasks.push({ deviceId: device.id, instruction });
    if (tasks.length >= 20) break;
  }

  if (tasks.length === 0) {
    throw new Error('AI 没有生成可执行任务，请换一种说法');
  }

  const normalizedScope: BatchPlanScope =
    scope === 'single' && tasks.length === 1 ? 'single' : 'batch';
  return {
    scope: normalizedScope,
    mode: tasks.length === 1 ? 'parallel' : mode,
    summary,
    tasks,
  };
}