import type { ViewerToStreamMessage } from '@adh/protocol';
import {
  TOUCH_ACTION,
  SCRCPY_KEYCODE,
  injectKeycode,
  injectScroll,
  injectTouch,
  expandPanel,
  rotateDevice,
  setClipboard,
  setScreenPowerMode,
} from './scrcpy-control.js';

/**
 * 把统一的 viewer 控制消息翻译成 scrcpy 控制字节。
 * 坐标使用 0..1 归一化，避免旋转/分辨率变化后错位。
 */
export class ScrcpyControlTranslator {
  /** 滚轮增量累计值，触控板的小步长会累积到一格再发送。 */
  private scrollRemainder = { h: 0, v: 0 };

  /** 浏览器滚轮约 100px 一次，按 50px 换算成一格（一次滚轮滚动两格）。 */
  private static readonly SCROLL_PIXELS_PER_CELL = 50;

  constructor(
    private readonly size: () => { width: number; height: number },
  ) {}

  translate(message: ViewerToStreamMessage): Buffer[] {
    switch (message.t) {
      case 'touch':
        return [this.touch(message)];
      case 'key':
        return this.key(message.key);
      case 'text':
        // 走剪贴板，兼容中文
        return [setClipboard(message.text, true)];
      case 'clipboard':
        // 只写剪贴板，不自动粘贴
        return [setClipboard(message.text, false)];
      case 'scroll': {
        const { width, height } = this.size();
        const x = message.x * width;
        const y = message.y * height;

        // scrcpy 的滚动量只有 -1..1，一格发一条消息，多滚几格就多发几条
        const perCell = ScrcpyControlTranslator.SCROLL_PIXELS_PER_CELL;
        this.scrollRemainder.v += -message.dy / perCell;
        this.scrollRemainder.h += message.dx / perCell;

        const rawV = Math.trunc(this.scrollRemainder.v);
        const rawH = Math.trunc(this.scrollRemainder.h);
        const vSteps = Math.max(-8, Math.min(8, rawV));
        const hSteps = Math.max(-8, Math.min(8, rawH));
        this.scrollRemainder.v = Math.max(-1, Math.min(1, this.scrollRemainder.v - vSteps));
        this.scrollRemainder.h = Math.max(-1, Math.min(1, this.scrollRemainder.h - hSteps));

        const count = Math.max(Math.abs(vSteps), Math.abs(hSteps));
        if (count === 0) return [];

        const v = Math.sign(vSteps);
        const h = Math.sign(hSteps);
        const messages: Buffer[] = [];
        for (let i = 0; i < count; i += 1) {
          messages.push(injectScroll(x, y, width, height, h, v));
        }
        return messages;
      }
      case 'rotate':
        return [rotateDevice()];
      case 'screen':
        return [setScreenPowerMode(message.on)];
      case 'panel':
        return [expandPanel(message.panel)];
      default:
        return [];
    }
  }

  private touch(message: Extract<ViewerToStreamMessage, { t: 'touch' }>): Buffer {
    const { width, height } = this.size();
    const x = message.x * width;
    const y = message.y * height;
    const action =
      message.phase === 'began'
        ? TOUCH_ACTION.down
        : message.phase === 'moved'
          ? TOUCH_ACTION.move
          : TOUCH_ACTION.up;

    const pressed = action !== TOUCH_ACTION.up;
    const pressure = pressed ? 65535 : 0;
    const buttons = pressed ? 1 : 0;
    const actionButton = action === TOUCH_ACTION.down ? 1 : 0;

    return injectTouch(
      action,
      message.pointerId,
      x,
      y,
      width,
      height,
      pressure,
      actionButton,
      buttons,
    );
  }

  private key(name: Extract<ViewerToStreamMessage, { t: 'key' }>['key']): Buffer[] {
    const keycode = SCRCPY_KEYCODE[name];
    return [injectKeycode(0, keycode), injectKeycode(1, keycode)];
  }
}