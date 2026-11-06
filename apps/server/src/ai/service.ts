import type { DeviceSummary } from '@adh/protocol';
import type { CommandBus } from '../command-bus.js';
import type { Logger } from '../log.js';
import type { SettingsService } from '../settings/service.js';
import type { StreamManager } from '../stream/manager.js';
import { chatCompletion, type ChatToolSchema } from './client.js';
import {
  AiDeviceController,
  BLACK_FRAME_BRIGHTNESS,
  FRAME_DIFF_THRESHOLD,
  frameBrightness,
  frameDiff,
  type AiKeyName,
  type AiScreenshot,
} from './device-control.js';
import {
  extractLaunchTarget,
  isLaunchOnlyTask,
  launchAppByName,
} from './app-launch.js';
import { extractAnswerFromScreen } from './extract.js';
import {
  isQueryTask,
  QUERY_GUIDE,
  QUERY_SYSTEM_PROMPT,
} from './query.js';
import type {
  AiChatMessage,
  AiEvent,
  AiFrame,
  AiFrameAction,
  AiModelMessage,
} from './types.js';

/**
 * 每个任务最多多少轮「截图 → 模型决策」。
 *
 * 这不是动作数：一轮模型可能返回多个 tool call。
 * Midscene 的 replanningCycleLimit 通用默认 20（UI-TARS 40、AutoGLM 100），
 * 我们每轮通常只做一个动作，取 30 留出登录、长表单这类任务的余量。
 */
const MAX_PLANNING_ROUNDS = 30;
/** 单个任务最多执行多少个实际动作，防止模型在一轮里疯狂重复点击。 */
const MAX_ACTIONS = 60;
/**
 * 查询任务的预算：目标只是读到屏幕上的信息，
 * 正常情况下 1~2 轮（点进会话 + 回答）就够，给到 8 已经非常宽松。
 */
const MAX_QUERY_ROUNDS = 8;
const MAX_QUERY_ACTIONS = 8;
const MAX_HISTORY_MESSAGES = 10;
const KEY_NAMES: AiKeyName[] = [
  'home',
  'back',
  'recent',
  'power',
  'volumeUp',
  'volumeDown',
  'mute',
];

/**
 * 固定追加到系统提示词后的执行规范。
 * 与可配置的 settings.systemPrompt 分开，避免用户自定义提示词后丢失这些约束。
 */
const ACTION_GUIDE = [
  '执行规范：',
  '- 纯观察 / 问答类任务：如果当前截图已经包含用户要求的信息，立即回答或调用 done，不要为了补充额外细节继续滑动。',
  '- 滑动前先确认目标信息还不在当前屏幕上；同一方向连续滑动不要超过 3 次。',
  '- 滑动后如果画面关键内容没有变化（已到页面底部或回弹），立即停止滑动，基于已经看到的信息回答，不要上下反复翻找。',
  '- 只查找用户明确要求的信息，不要主动浏览无关页面或在多个页面之间来回切换。',
  '- 锁屏处理：如果截图只有锁屏（时间、通知、上滑解锁、面容/指纹/密码提示）或全黑，不要猜密码。全黑时按一次 power 唤醒；锁屏时最多上滑一次尝试解锁。仍停在锁屏或出现密码/图案/生物识别提示时，立即 done 说明「设备已锁屏，需要先手动解锁」，不要反复滑动或等待。',
  '- 安全边界：不要执行或协助明显恶意、破坏性、不可逆的操作，包括批量关机 / 重启、恢复出厂设置、清空数据、卸载系统应用、删除文件、群发消息、支付 / 转账等。',
  '- 即使用户要求上述高风险操作，也应立即停止并说明需要人工确认或使用专门的管理入口，不要尝试通过反复点按设置页绕过。单台设备的普通观察和操作不受此限制。',
].join('\n');

const TOOLS: ChatToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'plan',
      description:
        '操作任务开始时先制定执行计划，把任务拆成 2~6 个可验证的子目标。纯观察/问答任务不要调用。执行中计划需要调整时可以再次调用。',
      parameters: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: { type: 'string' },
            description: '按顺序排列的子目标',
          },
        },
        required: ['steps'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tap',
      description:
        '点击屏幕上的一个点。x / y 优先使用 0~1 比例（0 表示最左/最上，1 表示最右/最下，例如屏幕中心是 0.5, 0.5）；也兼容截图像素坐标和 "50%" 这种百分比。',
      parameters: {
        type: 'object',
        properties: {
          x: {
            type: 'number',
            description: '横坐标，优先 0~1 比例',
          },
          y: {
            type: 'number',
            description: '纵坐标，优先 0~1 比例',
          },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'swipe',
      description: '从一点滑动到另一点，常用于翻页、滚动列表。坐标规则与 tap 相同。',
      parameters: {
        type: 'object',
        properties: {
          fromX: { type: 'number' },
          fromY: { type: 'number' },
          toX: { type: 'number' },
          toY: { type: 'number' },
          duration: {
            type: 'number',
            description: '滑动时长（毫秒），默认 300',
          },
        },
        required: ['fromX', 'fromY', 'toX', 'toY'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'input_text',
      description: '向当前焦点输入框输入文字。输入前请先点击输入框。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要输入的文字' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'press_key',
      description: '按下系统按键。',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            enum: KEY_NAMES,
            description:
              'home=主屏，back=返回，recent=多任务，power=电源，volumeUp/volumeDown=音量，mute=静音',
          },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait',
      description: '等待一段时间，让界面完成加载或动画。',
      parameters: {
        type: 'object',
        properties: {
          ms: { type: 'number', description: '等待毫秒数，最大 5000' },
        },
        required: ['ms'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description:
        '操作任务完成或无法继续时调用，summary 是给用户看的结果。纯观察/问答任务可以直接用文字回答，不需要调用。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '给用户的简要结果说明' },
        },
        required: ['summary'],
      },
    },
  },
];

export interface AiChatDeps {
  settings: SettingsService;
  streams: StreamManager;
  commands: CommandBus;
  logger: Logger;
}

export interface AiChatOptions {
  device: DeviceSummary;
  messages: AiChatMessage[];
  signal: AbortSignal;
  onEvent: (event: AiEvent) => void;
  /** 可选：把初始帧和每轮动作后的截图交给调用方（用于任务回放）。 */
  onFrame?: (frame: AiFrame) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 截图全黑时先唤醒并二次确认。
 *
 * 纯黑画面可能是息屏、锁屏黑屏，也可能是刚启动应用的黑帧。
 * 连续两次（约 2.4 秒）仍是纯黑就直接失败，避免模型以为在加载、
 * 用 wait 把动作预算耗光后给出「看不到内容」的错误结论。
 */
async function ensureScreenAwake(
  controller: AiDeviceController,
  device: DeviceSummary,
  shot: AiScreenshot,
  onEvent: (event: AiEvent) => void,
  logger: Logger,
): Promise<AiScreenshot> {
  if (frameBrightness(shot.signature) >= BLACK_FRAME_BRIGHTNESS) return shot;

  onEvent({ type: 'status', message: '屏幕似乎全黑，正在尝试唤醒…' });
  await controller.wake(device);
  await sleep(1_200);

  let next = await controller.screenshot(device);
  if (frameBrightness(next.signature) >= BLACK_FRAME_BRIGHTNESS) {
    logger.info({ deviceId: device.id }, 'ai screen awake after wake');
    return next;
  }

  await sleep(1_200);
  next = await controller.screenshot(device);
  if (frameBrightness(next.signature) >= BLACK_FRAME_BRIGHTNESS) {
    logger.info({ deviceId: device.id }, 'ai screen awake after wait');
    return next;
  }

  throw new Error(
    '设备屏幕持续全黑（可能已息屏、锁屏或应用未启动），请先点亮并解锁后重试',
  );
}

function planSteps(args: Record<string, unknown>): string[] {
  const raw = args.steps;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is string =>
        typeof item === 'string' && item.trim().length > 0,
    )
    .map((item) => item.trim())
    .slice(0, 12);
}

function numberArg(args: Record<string, unknown>, name: string): number {
  const raw = args[name];
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`参数 ${name} 必须是数字，收到 ${JSON.stringify(raw)}`);
  }
  return value;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`参数 ${name} 必须是非空字符串`);
  }
  return value;
}

/**
 * 从模型输出里取一对坐标。
 *
 * 部分模型会把 x / y 合并成 `[311, 646]`、`"311,646"` 或
 * `{ x: 311, y: 646 }`，这里统一拆开，避免直接抛「坐标无效」。
 */
function pairFrom(value: unknown): [unknown, unknown] | null {
  if (Array.isArray(value) && value.length >= 2) {
    return [value[0], value[1]];
  }
  if (typeof value === 'string') {
    const parts = value.split(/[,，\s]+/).filter(Boolean);
    if (parts.length >= 2) return [parts[0], parts[1]];
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const x = object.x ?? object.left;
    const y = object.y ?? object.top;
    if (x !== undefined && y !== undefined) return [x, y];
  }
  return null;
}

function pairArgs(
  args: Record<string, unknown>,
  listKeys: string[],
  xKey: string,
  yKey: string,
): [unknown, unknown] {
  for (const key of listKeys) {
    const pair = pairFrom(args[key]);
    if (pair) return pair;
  }
  return pairFrom(args[xKey]) ?? [args[xKey], args[yKey]];
}

/** 把同一个坐标的不同参数写法（x="0.5,0.145" / x=0.5,y=0.145）归一化。 */
function coordKey(value: unknown): string {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(3) : String(value);
}

function actionKey(name: string, args: Record<string, unknown>): string {
  if (name === 'tap') {
    const [x, y] = pairArgs(
      args,
      ['point', 'coordinate', 'position', 'xy'],
      'x',
      'y',
    );
    return `tap:${coordKey(x)}:${coordKey(y)}`;
  }
  if (name === 'swipe') {
    const [fromX, fromY] = pairArgs(
      args,
      ['from', 'start', 'fromPoint'],
      'fromX',
      'fromY',
    );
    const [toX, toY] = pairArgs(
      args,
      ['to', 'end', 'toPoint'],
      'toX',
      'toY',
    );
    return `swipe:${coordKey(fromX)}:${coordKey(fromY)}:${coordKey(toX)}:${coordKey(toY)}`;
  }
  if (name === 'input_text') return `input_text:${String(args.text ?? '')}`;
  if (name === 'press_key') return `press_key:${String(args.key ?? '')}`;
  return `${name}:${JSON.stringify(args)}`;
}

function buildMessages(
  systemPrompt: string,
  history: AiChatMessage[],
  prompt: string,
  shot: AiScreenshot,
): AiModelMessage[] {
  const previous = history.slice(0, -1).map<AiModelMessage>((message) => ({
    role: message.role,
    content: message.content,
  }));
  return [
    { role: 'system', content: systemPrompt },
    ...previous,
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${shot.base64}`,
            detail: 'high',
          },
        },
      ],
    },
  ];
}

/**
 * 多轮对话 + 工具调用的核心循环。
 *
 * 每一轮都重新截图，把「历史文本 + 已执行步骤 + 最新截图」发给模型；
 * 模型返回工具调用就执行，返回纯文本就结束。这样不会把多张图片
 * 累积进上下文，token 成本可控。
 */
export async function runAiChat(
  deps: AiChatDeps,
  options: AiChatOptions,
): Promise<void> {
  const settings = await deps.settings.getAiSettings();
  if (!settings.enabled) {
    throw new Error('AI 助手未启用，请先在系统设置中开启');
  }
  if (!settings.apiKey) {
    throw new Error('尚未配置模型 API Key');
  }
  if (!settings.model) {
    throw new Error('尚未配置模型名称');
  }

  const history = options.messages
    .filter((message) => message.content.trim().length > 0)
    .slice(-MAX_HISTORY_MESSAGES);
  const current = [...history].reverse().find((message) => message.role === 'user');
  if (!current) throw new Error('缺少用户消息');

  // 查询/读取类任务走精简链路：不制定计划、动作预算更小，
  // 最终由一次纯视觉提取给出结论。
  const queryTask = isQueryTask(current.content);
  const tools = queryTask
    ? TOOLS.filter((tool) => tool.function.name !== 'plan')
    : TOOLS;
  // 查询任务用专用提示词，避免通用提示词里「问答类不要点击」和
  // 「先点进会话再读取」互相打架，也缩短首轮上下文。
  const systemPrompt = queryTask
    ? `${QUERY_SYSTEM_PROMPT}\n\n${QUERY_GUIDE}`
    : `${settings.systemPrompt}\n\n${ACTION_GUIDE}`;

  const controller = new AiDeviceController(deps);
  const transcript: string[] = [];
  const { signal, onEvent, onFrame, device } = options;
  let reply = '';
  let plan: string[] = [];
  const recentActions: string[] = [];
  let totalActions = 0;

  // “帮我打开共享商家端”这类任务先走应用启动快速通道：
  // 包名明确时直接 adb / iOS launch；自定义 App 用桌面图标 adb tap。
  // 成功后再交给视觉确认真实界面，省掉模型找图标、点坐标的步骤。
  const launchTarget = extractLaunchTarget(current.content);
  if (launchTarget) {
    try {
      const launchStart = Date.now();
      const launched = await launchAppByName({
        device,
        name: launchTarget,
        commands: deps.commands,
        logger: deps.logger,
      });
      if (launched) {
        deps.logger.info(
          {
            deviceId: device.id,
            name: launchTarget,
            packageName: launched.packageName,
            method: launched.method,
            ms: Date.now() - launchStart,
          },
          'ai fast launch',
        );
        onEvent({
          type: 'tool',
          name: 'launch_app',
          args: {
            name: launchTarget,
            ...(launched.packageName
              ? { package: launched.packageName }
              : {}),
          },
        });
        onEvent({
          type: 'tool_result',
          name: 'launch_app',
          ok: true,
          detail: `已启动 ${launchTarget}`,
        });

        if (launched.trusted && isLaunchOnlyTask(current.content)) {
          const content = `已打开 ${launchTarget}`;
          onEvent({ type: 'reply', content });
          onEvent({ type: 'done' });
          return;
        }

        transcript.push(
          `已通过 ${launched.method} 启动 ${launchTarget}` +
            `${launched.packageName ? ` (${launched.packageName})` : ''}`,
        );
        await sleep(1_500);
      }
    } catch (error) {
      deps.logger.warn(
        { deviceId: device.id, name: launchTarget, err: String(error) },
        'ai fast launch failed',
      );
    }
  }

  // 视觉闭环的第一步：等画面稳定再让模型判断，避免拿到转场中间态
  const observeStart = Date.now();
  let shot = await controller.observe(device);
  shot = await ensureScreenAwake(
    controller,
    device,
    shot,
    onEvent,
    deps.logger,
  );
  deps.logger.info(
    {
      deviceId: device.id,
      ms: Date.now() - observeStart,
      width: shot.width,
      height: shot.height,
      content: `${shot.contentWidth}x${shot.contentHeight}`,
    },
    'ai observe initial',
  );
  onFrame?.({
    shot,
    at: Date.now(),
    phase: 'initial',
    actions: [],
    summary: '初始画面',
  });

  for (
    let step = 0;
    step < (queryTask ? MAX_QUERY_ROUNDS : MAX_PLANNING_ROUNDS);
    step += 1
  ) {
    if (signal.aborted) throw new Error('已取消');

    onEvent({
      type: 'status',
      message: step === 0 ? '正在理解画面…' : '正在根据最新画面决策…',
    });

    const executedText = transcript.length
      ? [
          '',
          '已执行的操作：',
          ...transcript.map((item, index) => `${index + 1}. ${item}`),
        ].join('\n')
      : '';
    const planText = plan.length
      ? [
          '',
          '当前计划：',
          ...plan.map((item, index) => `${index + 1}. ${item}`),
        ].join('\n')
      : '';

    const prompt =
      step === 0
        ? [
            current.content,
            '',
            `本轮截图分辨率：${shot.width}x${shot.height}。`,
            '右下角的纯白边是 28 像素对齐的补齐区域，不是界面内容，不要点那里。',
            '坐标优先使用 0~1 比例（屏幕中心是 0.5, 0.5），不要按 1080 / 2400 这类设备原始像素输出。',
            planText,
            executedText,
          ].join('\n')
        : [
            `用户任务：${current.content}`,
            '',
            planText,
            '已执行的操作：',
            ...transcript.map((item, index) => `${index + 1}. ${item}`),
            '',
            `本轮截图分辨率：${shot.width}x${shot.height}。`,
            '右下角的纯白边是 28 像素对齐的补齐区域，不是界面内容，不要点那里。',
            '坐标优先使用 0~1 比例（屏幕中心是 0.5, 0.5），不要按设备原始像素输出。',
            '',
            '这是执行后的最新屏幕截图。请继续完成上面的用户任务，每次只做必要的下一步；任务完成时调用 done。',
          ].join('\n');

    const modelStart = Date.now();
    const result = await chatCompletion(
      settings,
      buildMessages(
        systemPrompt,
        history,
        prompt,
        shot,
      ),
      tools,
      signal,
    );
    deps.logger.info(
      {
        deviceId: device.id,
        step,
        ms: Date.now() - modelStart,
        toolCalls: result.toolCalls.length,
      },
      'ai model call',
    );

    if (result.toolCalls.length === 0) {
      reply = result.content.trim();
      // 操作任务既没有动作也没有回答，说明模型放弃了，不能伪装成功；
      // 查询任务则交给循环结束后的视觉提取兜底。
      if (!reply && !queryTask) {
        throw new Error('模型没有返回可用的回答，请重试');
      }
      break;
    }

    let finished = false;
    let acted = false;
    let lastAction = '';
    let settleMs = 300;
    let budgetExhausted = false;
    const roundActions: AiFrameAction[] = [];
    for (const call of result.toolCalls) {
      if (signal.aborted) throw new Error('已取消');

      // 查询任务到动作上限后不再执行，直接基于当前截图提取答案，
      // 避免模型为了「再确认一下」无限滑动。
      if (
        queryTask &&
        call.name !== 'plan' &&
        call.name !== 'done' &&
        totalActions >= MAX_QUERY_ACTIONS
      ) {
        budgetExhausted = true;
        break;
      }

      onEvent({ type: 'tool', name: call.name, args: call.args });

      if (call.name !== 'plan' && call.name !== 'done') {
        const key = actionKey(call.name, call.args);
        const repeated =
          recentActions[recentActions.length - 1] === key &&
          recentActions[recentActions.length - 2] === key;
        if (repeated) {
          const detail =
            '连续重复同一动作，已跳过。请换坐标、滚动或等待，或调用 done。';
          transcript.push(`${call.name} 被跳过：连续重复同一动作`);
          roundActions.push({
            name: call.name,
            args: call.args,
            detail,
            ok: false,
          });
          onEvent({
            type: 'tool_result',
            name: call.name,
            ok: false,
            detail,
          });
          continue;
        }

        recentActions.push(key);
        if (recentActions.length > 6) recentActions.shift();
        acted = true;
        lastAction = call.name;
        totalActions += 1;
        if (totalActions > MAX_ACTIONS) {
          throw new Error(
            `操作动作过多（超过 ${MAX_ACTIONS} 个），已停止，请检查当前页面后重试`,
          );
        }
      }

      if (call.name === 'input_text') settleMs = 600;
      try {
        const detail = await executeTool(controller, device, shot, call.name, call.args);
        if (call.name === 'plan') {
          plan = planSteps(call.args);
        } else {
          transcript.push(formatStep(call.name, call.args, detail));
          if (call.name !== 'done') {
            roundActions.push({
              name: call.name,
              args: call.args,
              detail,
              ok: true,
            });
          }
        }
        onEvent({
          type: 'tool_result',
          name: call.name,
          ok: true,
          detail,
        });

        if (call.name === 'done') {
          reply = detail;
          finished = true;
          break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 投屏会话 / 控制通道断开后重试没有意义，直接失败，避免任务空转。
        if (/投屏会话未就绪|控制通道未就绪/.test(message)) {
          throw new Error(message);
        }
        transcript.push(`${call.name} 失败：${message}`);
        if (call.name !== 'plan' && call.name !== 'done') {
          roundActions.push({
            name: call.name,
            args: call.args,
            detail: message,
            ok: false,
          });
        }
        onEvent({
          type: 'tool_result',
          name: call.name,
          ok: false,
          detail: message,
        });
      }
    }

    if (finished) break;
    if (budgetExhausted) break;

    // 动作执行后重新截图并对比，把「有没有生效」明确反馈给模型
    if (acted) {
      onEvent({ type: 'status', message: '正在校验画面变化…' });
      // 动作后只截一张，按动作类型等一小段再取图；
      // 不再走 observe 的多张稳定性检测，避免每一步多花几秒。
      await sleep(settleMs);
      const nextStart = Date.now();
      const next = await controller.screenshot(device);
      deps.logger.info(
        {
          deviceId: device.id,
          step,
          settleMs,
          ms: Date.now() - nextStart,
          width: next.width,
          height: next.height,
          content: `${next.contentWidth}x${next.contentHeight}`,
        },
        'ai screenshot after action',
      );
      const diff = frameDiff(shot.signature, next.signature);
      const noChange = diff < FRAME_DIFF_THRESHOLD;
      const feedback = noChange
        ? lastAction === 'input_text'
          ? '输入后画面没有变化：输入框可能没聚焦，或该页面不接受 ADB 输入。请先点击输入框再输入，仍无变化就改用页面自带的数字键盘。'
          : lastAction === 'tap'
            ? '点击后画面没有变化：如果刚点的是输入框，请直接调用 input_text 输入内容，不要反复点击；否则换坐标、滚动或等待加载。'
            : '界面几乎没有变化，动作可能没有生效，请检查坐标或等待加载后重试'
        : `界面已更新（变化 ${(diff * 100).toFixed(1)}%）`;
      transcript.push(`画面校验：${feedback}`);
      onEvent({ type: 'status', message: feedback });
      shot = next;
      onFrame?.({
        shot: next,
        at: Date.now(),
        phase: 'after_action',
        actions: roundActions,
        summary: feedback,
      });
    }
  }

  // 查询任务没有拿到回答（模型返回空、或动作预算用尽）时，
  // 用一次纯视觉提取兜底：让模型基于当前截图做语义提取，而不是 OCR。
  if (!reply && queryTask) {
    onEvent({ type: 'status', message: '正在整理画面信息…' });
    try {
      reply = await extractAnswerFromScreen({
        settings,
        instruction: current.content,
        transcript,
        shot,
        signal,
        logger: deps.logger,
        deviceId: device.id,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      deps.logger.warn(
        {
          deviceId: device.id,
          err: error instanceof Error ? error.message : String(error),
        },
        'ai extract answer failed',
      );
    }
  }

  // 查询任务即使提取不到内容也给出诚实结论，不要落成「任务未完成」。
  if (!reply && queryTask) {
    reply = '当前画面没有读到能回答问题的内容，请确认页面已经打开或换个问法。';
  }

  if (!reply) {
    const reason = transcript.length
      ? `任务未完成：已达到单任务最大决策轮数（${MAX_PLANNING_ROUNDS} 轮），已执行 ${totalActions} 个动作。请检查当前页面后继续，或把任务拆小。`
      : '没有可执行的操作。';
    // 不能把“达到上限”当成成功：先发一条可见的说明，再抛错让任务落 failed。
    onEvent({ type: 'reply', content: reason });
    throw new Error(reason);
  }

  onEvent({ type: 'reply', content: reply });
  onEvent({ type: 'done' });
}

function formatStep(
  name: string,
  args: Record<string, unknown>,
  detail: string,
): string {
  const params = Object.entries(args)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
  return `${name}(${params}) → ${detail}`;
}

async function executeTool(
  controller: AiDeviceController,
  device: DeviceSummary,
  shot: AiScreenshot,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case 'plan': {
      const steps = planSteps(args);
      if (steps.length === 0) throw new Error('计划不能为空');
      return `已制定 ${steps.length} 步计划`;
    }
    case 'tap': {
      const [x, y] = pairArgs(
        args,
        ['point', 'coordinate', 'position', 'xy'],
        'x',
        'y',
      );
      const point = await controller.tap(device, shot, x, y);
      return `已点击 (${(point.x * 100).toFixed(0)}%, ${(point.y * 100).toFixed(0)}%)`;
    }
    case 'swipe': {
      const [fromX, fromY] = pairArgs(
        args,
        ['from', 'start', 'fromPoint'],
        'fromX',
        'fromY',
      );
      const [toX, toY] = pairArgs(
        args,
        ['to', 'end', 'toPoint'],
        'toX',
        'toY',
      );
      await controller.swipe(
        device,
        shot,
        fromX,
        fromY,
        toX,
        toY,
        args.duration === undefined ? 300 : numberArg(args, 'duration'),
      );
      return '已滑动';
    }
    case 'input_text': {
      await controller.inputText(device, stringArg(args, 'text'));
      return '已输入文字';
    }
    case 'press_key': {
      const key = stringArg(args, 'key') as AiKeyName;
      if (!KEY_NAMES.includes(key)) {
        throw new Error(`不支持的按键：${key}`);
      }
      await controller.pressKey(device, key);
      return `已按下 ${key}`;
    }
    case 'wait': {
      const ms = Math.min(5_000, Math.max(0, numberArg(args, 'ms')));
      await sleep(ms);
      return `已等待 ${ms}ms`;
    }
    case 'done':
      return stringArg(args, 'summary');
    default:
      throw new Error(`未知工具：${name}`);
  }
}

