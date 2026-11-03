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
        return [
          injectScroll(
            message.x * width,
            message.y * height,
            width,
            height,
            message.dx,
            -message.dy,
          ),
        ];
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