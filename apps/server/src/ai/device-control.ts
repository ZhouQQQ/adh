import sharp from 'sharp';
import {
  BUILTIN_AGENT_ID,
  type DeviceSummary,
  type IosInput,
  type ViewerToStreamMessage,
} from '@adh/protocol';
import {
  adbInputText,
  applyIosInput,
  captureScreenshot,
  launchAndroidApp,
  wdaPortFor,
  wdaScreenshot,
} from '@adh/device-host';
import type { CommandBus } from '../command-bus.js';
import type { Logger } from '../log.js';
import type { StreamManager } from '../stream/manager.js';

/** 送给模型的截图宽度，太大 token 成本高，太小中文图标文字容易看不清。 */
const SCREENSHOT_WIDTH = 960;

export interface AiScreenshot {
  /** JPEG base64，不含 data: 前缀。 */
  base64: string;
  /** 发给模型的图片宽高（右下可能补了 28 像素对齐的白边）。 */
  width: number;
  height: number;
  /** 图片里真正对应设备画面的内容宽高，坐标换算用这个。 */
  contentWidth: number;
  contentHeight: number;
  /** 64×64 灰度指纹，用于判断动作前后画面是否变化。 */
  signature: Buffer;
}

/** 两张截图的平均像素差异，0 表示完全相同。 */
export function frameDiff(a: Buffer, b: Buffer): number {
  if (a.length === 0 || a.length !== b.length) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += Math.abs(a[i]! - b[i]!);
  }
  return sum / a.length / 255;
}

/** 动作前后画面差异低于该值，认为「没有明显变化」。 */
export const FRAME_DIFF_THRESHOLD = 0.003;

export type AiKeyName =
  | 'home'
  | 'back'
  | 'recent'
  | 'power'
  | 'volumeUp'
  | 'volumeDown'
  | 'mute';

const ANDROID_KEYS: AiKeyName[] = [
  'home',
  'back',
  'recent',
  'power',
  'volumeUp',
  'volumeDown',
  'mute',
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 把模型给的坐标换算成 0..1。
 * 兼容三类输出：
 * - 像素坐标：100
 * - 比例坐标：0.5
 * - 百分比 / 带单位：\"50%\"、\"100px\"
 */
function coordinate(value: unknown, total: number): number {
  // 模型偶尔把一对坐标塞进单个参数，取第一个值兜底
  if (Array.isArray(value)) value = value[0];
  if (typeof value === 'string' && value.includes(',')) {
    value = value.split(/[,，]/)[0]?.trim();
  }

  let num: number;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.endsWith('%')) {
      const percent = Number(text.slice(0, -1).trim());
      if (!Number.isFinite(percent)) throw new Error(`坐标无效：${value}`);
      return clamp01(percent / 100);
    }
    num = Number(text.replace(/px$/i, '').trim());
  } else {
    num = Number(value);
  }
  if (!Number.isFinite(num)) {
    throw new Error(`坐标无效：${JSON.stringify(value)}`);
  }
  // 0..1 视为归一化比例；否则按截图像素换算
  if (num >= 0 && num <= 1) return num;
  if (total <= 0) return 0;
  return clamp01(num / total);
}

function numberArg(args: Record<string, unknown>, name: string): number {
  const value = Number(args[name]);
  if (!Number.isFinite(value)) throw new Error(`参数 ${name} 必须是数字`);
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
 * 把 AI 的工具调用落到设备上。
 *
 * 所有动作都复用现有投屏会话 / WDA 通道，不会另开 adb 连接，
 * 因此不会和用户正在观看的 scrcpy 画面冲突。
 */
export class AiDeviceController {
  constructor(
    private readonly deps: {
      streams: StreamManager;
      commands: CommandBus;
      logger: Logger;
    },
  ) {}

  async screenshot(device: DeviceSummary): Promise<AiScreenshot> {
    const png = await this.capture(device);
    try {
      // 先等比缩放到固定宽度，再补齐到 28 的倍数。
      // 部分 vision 模型会按 28 像素块内部缩放，不补齐时模型看到的
      // 坐标和我们按原始尺寸换算的坐标会有一个固定偏移。
      const resized = await sharp(png)
        .resize({ width: SCREENSHOT_WIDTH, withoutEnlargement: true })
        .toBuffer({ resolveWithObject: true });
      const contentWidth = resized.info.width;
      const contentHeight = resized.info.height;
      const paddedWidth = Math.ceil(contentWidth / 28) * 28;
      const paddedHeight = Math.ceil(contentHeight / 28) * 28;

      const imagePipeline =
        paddedWidth === contentWidth && paddedHeight === contentHeight
          ? sharp(resized.data)
          : sharp(resized.data).extend({
              right: paddedWidth - contentWidth,
              bottom: paddedHeight - contentHeight,
              background: { r: 255, g: 255, b: 255, alpha: 1 },
            });

      const [image, signature] = await Promise.all([
        imagePipeline
          .jpeg({ quality: 90 })
          .toBuffer({ resolveWithObject: true }),
        sharp(resized.data)
          .resize(64, 64, { fit: 'fill' })
          .greyscale()
          .raw()
          .toBuffer(),
      ]);
      return {
        base64: image.data.toString('base64'),
        width: image.info.width,
        height: image.info.height,
        contentWidth,
        contentHeight,
        signature,
      };
    } catch (error) {
      throw new Error(
        `截图处理失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 等待画面稳定后再截图。
   *
   * 动画、转场、列表加载都会让「动作后立刻截图」拿到中间态。
   * 连续两帧差异很小时才返回，最多等约 1.5 秒。
   */
  async observe(device: DeviceSummary): Promise<AiScreenshot> {
    let current = await this.screenshot(device);
    // 通常 2 张就能确认画面稳定；只有仍在变化时才补第 3 张。
    // 远程设备每张截图都要走一次 agent 命令通道，原来的 5 张太慢。
    await sleep(180);
    let next = await this.screenshot(device);
    if (frameDiff(current.signature, next.signature) >= 0.004) {
      current = next;
      await sleep(180);
      next = await this.screenshot(device);
    }
    return next;
  }

  async tap(
    device: DeviceSummary,
    shot: AiScreenshot,
    x: unknown,
    y: unknown,
  ): Promise<{ x: number; y: number }> {
    const nx = coordinate(x, shot.contentWidth);
    const ny = coordinate(y, shot.contentHeight);
    this.deps.logger.info(
      {
        deviceId: device.id,
        shot: `${shot.width}x${shot.height}`,
        content: `${shot.contentWidth}x${shot.contentHeight}`,
        deviceResolution: device.resolution,
        raw: [x, y],
        normalized: [nx, ny],
      },
      'ai tap',
    );
    if (device.platform === 'ios') {
      await this.sendIos(device, { type: 'tap', x: nx, y: ny });
      return { x: nx, y: ny };
    }
    await this.sendControl(device, {
      t: 'touch',
      phase: 'began',
      x: nx,
      y: ny,
      pointerId: 0,
      pressure: 1,
    });
    await sleep(40);
    await this.sendControl(device, {
      t: 'touch',
      phase: 'ended',
      x: nx,
      y: ny,
      pointerId: 0,
      pressure: 0,
    });
    return { x: nx, y: ny };
  }

  async swipe(
    device: DeviceSummary,
    shot: AiScreenshot,
    fromX: unknown,
    fromY: unknown,
    toX: unknown,
    toY: unknown,
    durationMs = 300,
  ): Promise<void> {
    const x1 = coordinate(fromX, shot.contentWidth);
    const y1 = coordinate(fromY, shot.contentHeight);
    const x2 = coordinate(toX, shot.contentWidth);
    const y2 = coordinate(toY, shot.contentHeight);
    const duration = Math.min(5_000, Math.max(100, durationMs));

    if (device.platform === 'ios') {
      await this.sendIos(device, {
        type: 'swipe',
        fromX: x1,
        fromY: y1,
        toX: x2,
        toY: y2,
        duration: duration / 1000,
      });
      return;
    }

    await this.sendControl(device, {
      t: 'touch',
      phase: 'began',
      x: x1,
      y: y1,
      pointerId: 0,
      pressure: 1,
    });
    const steps = 8;
    for (let i = 1; i <= steps; i += 1) {
      const ratio = i / steps;
      await sleep(duration / steps);
      await this.sendControl(device, {
        t: 'touch',
        phase: 'moved',
        x: x1 + (x2 - x1) * ratio,
        y: y1 + (y2 - y1) * ratio,
        pointerId: 0,
        pressure: 1,
      });
    }
    await this.sendControl(device, {
      t: 'touch',
      phase: 'ended',
      x: x2,
      y: y2,
      pointerId: 0,
      pressure: 0,
    });
  }

  async inputText(device: DeviceSummary, text: string): Promise<void> {
    if (device.platform === 'ios') {
      await this.sendIos(device, { type: 'text', text });
      return;
    }

    // 纯数字 / 英文优先 adb input text：微信红包金额、密码这类自定义
    // 数字键盘不一定响应 scrcpy 的文本注入，但焦点框能接收 ADB 按键。
    if (/^[\x20-\x7E]+$/.test(text)) {
      try {
        if (device.agentId === BUILTIN_AGENT_ID) {
          await adbInputText(device.udid, text);
        } else {
          const result = await this.deps.commands.send(
            device.agentId,
            'input.text',
            { udid: device.udid, text },
            device.id,
            8_000,
          );
          if (!result.ok) {
            throw new Error(result.error ?? 'ADB 文本输入失败');
          }
        }
        return;
      } catch (error) {
        this.deps.logger.warn(
          {
            deviceId: device.id,
            err: error instanceof Error ? error.message : String(error),
          },
          'adb input text failed, falling back to stream text',
        );
      }
    }

    await this.sendControl(device, { t: 'text', text });
  }

  async pressKey(device: DeviceSummary, key: AiKeyName): Promise<void> {
    if (!ANDROID_KEYS.includes(key)) {
      throw new Error(`不支持的按键：${key}`);
    }
    if (device.platform === 'ios') {
      await this.sendIos(device, this.toIosKey(key));
      return;
    }
    await this.sendControl(device, { t: 'key', key });
  }

  async launchApp(device: DeviceSummary, packageName: string): Promise<void> {
    if (device.platform === 'ios') {
      throw new Error('iOS 暂不支持按包名启动应用，请让用户手动打开');
    }
    if (device.agentId === BUILTIN_AGENT_ID) {
      const ok = await launchAndroidApp(device.udid, packageName);
      if (!ok) throw new Error(`应用启动失败：${packageName}`);
      return;
    }
    const result = await this.deps.commands.send(
      device.agentId,
      'app.launch',
      { udid: device.udid, package: packageName },
      device.id,
      20_000,
    );
    if (!result.ok) {
      throw new Error(result.error ?? `应用启动失败：${packageName}`);
    }
  }

  private async capture(device: DeviceSummary): Promise<Buffer> {
    if (device.agentId === BUILTIN_AGENT_ID) {
      if (device.platform === 'ios') {
        const png = await wdaScreenshot(wdaPortFor(device.udid));
        if (!png) throw new Error('iOS 截图失败，请确认 WDA 已启动');
        return png;
      }
      const shot = await captureScreenshot(device.udid);
      if (!shot) throw new Error('Android 截图失败');
      return shot.data;
    }

    const result = await this.deps.commands.send(
      device.agentId,
      'screenshot',
      { udid: device.udid, platform: device.platform },
      device.id,
      20_000,
    );
    if (!result.ok) throw new Error(result.error ?? '设备截图失败');
    const data = result.data as { base64?: unknown } | undefined;
    if (typeof data?.base64 !== 'string' || !data.base64) {
      throw new Error('设备未返回截图，请将该节点上的 agent 升级到支持 AI 的版本');
    }
    return Buffer.from(data.base64, 'base64');
  }

  private async sendControl(
    device: DeviceSummary,
    message: ViewerToStreamMessage,
  ): Promise<void> {
    const ok = this.deps.streams.sendControl(device.id, message);
    if (!ok) {
      throw new Error('投屏会话未就绪，请确认设备仍在控制中');
    }
  }

  private async sendIos(device: DeviceSummary, input: IosInput): Promise<void> {
    if (device.agentId === BUILTIN_AGENT_ID) {
      await applyIosInput(wdaPortFor(device.udid), input);
      return;
    }
    if (!this.deps.streams.sendIosInput(device.id, input)) {
      throw new Error('iOS 控制通道未就绪，请重新进入控制页');
    }
  }

  private toIosKey(key: AiKeyName): IosInput {
    switch (key) {
      case 'home':
        return { type: 'button', name: 'home' };
      case 'recent':
        return { type: 'appSwitcher' };
      case 'power':
        return { type: 'screenToggle' };
      case 'volumeUp':
        return { type: 'button', name: 'volumeUp' };
      case 'volumeDown':
        return { type: 'button', name: 'volumeDown' };
      case 'mute':
        return { type: 'mute' };
      case 'back':
        throw new Error('iOS 没有返回键，请点击界面左上角的返回按钮');
    }
  }
}