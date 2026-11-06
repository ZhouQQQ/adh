import { runCommand } from './exec.js';

/**
 * 点亮屏幕（KEYCODE_WAKEUP）。
 *
 * 和 KEYCODE_POWER 不同，它只唤醒、不会把已经亮着的屏幕关掉，
 * 适合 AI 任务在开始截图前做一次保守的唤醒。
 */
export async function adbWake(udid: string, timeoutMs = 5_000): Promise<void> {
  await runCommand(
    'adb',
    ['-s', udid, 'shell', 'input', 'keyevent', '224'],
    timeoutMs,
  );
}

/**
 * 用 ADB 向当前焦点输入框输入文本。
 *
 * 只处理 ASCII：中文在 adb `input text` 上不可靠，调用方应回退到
 * scrcpy 的剪贴板注入 / WDA 输入。
 */
export async function adbInputText(
  udid: string,
  text: string,
  timeoutMs = 10_000,
): Promise<void> {
  if (!text) return;
  if (!/^[\x20-\x7E]+$/.test(text)) {
    throw new Error('ADB 文本输入只支持 ASCII');
  }

  // Android `input text` 用 %s 表示空格，其余 shell 特殊字符需要转义
  const escaped = text
    .replace(/ /g, '%s')
    .replace(/([\\'"`$&|;<>()*?~!])/g, '\\$1');

  const result = await runCommand(
    'adb',
    ['-s', udid, 'shell', 'input', 'text', escaped],
    timeoutMs,
  );
  if (result.code !== 0 || /error|exception|not found/i.test(result.stderr)) {
    throw new Error(result.stderr.trim() || 'ADB 文本输入失败');
  }
}