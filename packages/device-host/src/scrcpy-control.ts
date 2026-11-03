/** scrcpy 控制消息序列化（协议版本 2.4）。 */

export const SCRCPY_KEYCODE = {
  home: 3,
  back: 4,
  recent: 187,
  power: 26,
  volumeUp: 24,
  volumeDown: 25,
  mute: 164,
  menu: 82,
  enter: 66,
  wakeup: 224,
} as const;

export type ScrcpyKeyName = keyof typeof SCRCPY_KEYCODE;

/** Android MotionEvent action 值。 */
export const TOUCH_ACTION = { down: 0, up: 1, move: 2 } as const;

const MSG_INJECT_KEYCODE = 0;
const MSG_INJECT_TEXT = 1;
const MSG_INJECT_TOUCH_EVENT = 2;
const MSG_INJECT_SCROLL_EVENT = 3;
const MSG_BACK_OR_SCREEN_ON = 4;
const MSG_EXPAND_NOTIFICATION_PANEL = 5;
const MSG_EXPAND_SETTINGS_PANEL = 6;
const MSG_SET_CLIPBOARD = 9;
const MSG_SET_SCREEN_POWER_MODE = 10;
const MSG_ROTATE_DEVICE = 11;

export function injectKeycode(
  action: 0 | 1,
  keycode: number,
  repeat = 0,
  metaState = 0,
): Buffer {
  // type(1) + action(1) + keycode(4) + repeat(4) + metaState(4) = 14
  const buf = Buffer.alloc(14);
  buf.writeUInt8(MSG_INJECT_KEYCODE, 0);
  buf.writeUInt8(action, 1);
  buf.writeUInt32BE(keycode, 2);
  buf.writeUInt32BE(repeat, 6);
  buf.writeUInt32BE(metaState, 10);
  return buf;
}

export function injectText(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const buf = Buffer.alloc(5 + body.length);
  buf.writeUInt8(MSG_INJECT_TEXT, 0);
  buf.writeUInt32BE(body.length, 1);
  body.copy(buf, 5);
  return buf;
}

/**
 * 通过剪贴板输入文本。
 *
 * INJECT_TEXT 走 KeyCharacterMap，只能映射 ASCII，中文会直接失败；
 * 剪贴板方案由设备端设置剪贴板并自动粘贴，中英文都可用。
 */
export function setClipboard(text: string, paste = true): Buffer {
  const body = Buffer.from(text, 'utf8');
  const buf = Buffer.alloc(1 + 8 + 1 + 4 + body.length);
  let offset = 0;
  buf.writeUInt8(MSG_SET_CLIPBOARD, offset);
  offset += 1;
  buf.writeBigUInt64BE(0n, offset);
  offset += 8;
  buf.writeUInt8(paste ? 1 : 0, offset);
  offset += 1;
  buf.writeUInt32BE(body.length, offset);
  offset += 4;
  body.copy(buf, offset);
  return buf;
}

/** 鼠标滚轮事件（scrcpy INJECT_SCROLL_EVENT）。 */
export function injectScroll(
  x: number,
  y: number,
  width: number,
  height: number,
  hscroll: number,
  vscroll: number,
): Buffer {
  const clamp = (value: number): number =>
    Math.max(-32768, Math.min(32767, Math.round(value)));
  const buf = Buffer.alloc(1 + 4 + 4 + 2 + 2 + 2 + 2);
  let offset = 0;
  buf.writeUInt8(MSG_INJECT_SCROLL_EVENT, offset);
  offset += 1;
  buf.writeInt32BE(Math.round(x), offset);
  offset += 4;
  buf.writeInt32BE(Math.round(y), offset);
  offset += 4;
  buf.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(width))), offset);
  offset += 2;
  buf.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(height))), offset);
  offset += 2;
  buf.writeInt16BE(clamp(hscroll), offset);
  offset += 2;
  buf.writeInt16BE(clamp(vscroll), offset);
  return buf;
}

export function injectTouch(
  action: 0 | 1 | 2,
  pointerId: number,
  x: number,
  y: number,
  screenWidth: number,
  screenHeight: number,
  pressure: number,
  actionButton: number,
  buttons: number,
): Buffer {
  const buf = Buffer.alloc(32);
  let offset = 0;
  buf.writeUInt8(MSG_INJECT_TOUCH_EVENT, offset);
  offset += 1;
  buf.writeUInt8(action, offset);
  offset += 1;
  buf.writeBigUInt64BE(BigInt(pointerId), offset);
  offset += 8;
  buf.writeInt32BE(Math.round(x), offset);
  offset += 4;
  buf.writeInt32BE(Math.round(y), offset);
  offset += 4;
  buf.writeUInt16BE(screenWidth, offset);
  offset += 2;
  buf.writeUInt16BE(screenHeight, offset);
  offset += 2;
  buf.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(pressure))), offset);
  offset += 2;
  buf.writeUInt32BE(actionButton >>> 0, offset);
  offset += 4;
  buf.writeUInt32BE(buttons >>> 0, offset);
  return buf;
}

export function backOrScreenOn(action: 0 | 1): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt8(MSG_BACK_OR_SCREEN_ON, 0);
  buf.writeUInt8(action, 1);
  return buf;
}

export function rotateDevice(): Buffer {
  const buf = Buffer.alloc(1);
  buf.writeUInt8(MSG_ROTATE_DEVICE, 0);
  return buf;
}

/** 拉下通知栏或快捷设置面板。 */
export function expandPanel(panel: 'notification' | 'settings'): Buffer {
  return Buffer.from([
    panel === 'settings' ? MSG_EXPAND_SETTINGS_PANEL : MSG_EXPAND_NOTIFICATION_PANEL,
  ]);
}

/** 关闭 / 点亮屏幕，不触发锁屏。 */
export function setScreenPowerMode(on: boolean): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt8(MSG_SET_SCREEN_POWER_MODE, 0);
  buf.writeUInt8(on ? 1 : 0, 1);
  return buf;
}