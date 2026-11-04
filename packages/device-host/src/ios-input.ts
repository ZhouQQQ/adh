import type { IosInput } from '@adh/protocol';
import {
  wdaAppSwitcher,
  wdaLock,
  wdaPinch,
  wdaPressButton,
  wdaSwipe,
  wdaTap,
  wdaTypeText,
  wdaUnlock,
  wdaWindow,
} from './ios-wda-client.js';

/**
 * 执行一条 iOS 输入。
 *
 * server（设备插在本机）和 agent（远程宿主机）共用：
 * 谁离设备近，就在谁那里调用 WDA。
 *
 * screenToggle 需要调用方传入当前亮屏状态，返回新的状态。
 */
export async function applyIosInput(
  port: number,
  input: IosInput,
  screenUnlocked = true,
): Promise<{ screenUnlocked?: boolean }> {
  switch (input.type) {
    case 'tap': {
      const size = await wdaWindow(port);
      await wdaTap(port, input.x * size.width, input.y * size.height);
      return {};
    }
    case 'swipe': {
      const size = await wdaWindow(port);
      await wdaSwipe(
        port,
        input.fromX * size.width,
        input.fromY * size.height,
        input.toX * size.width,
        input.toY * size.height,
        input.duration ?? 0.3,
      );
      return {};
    }
    case 'pinch':
      // duration 是期望耗时（秒），换算成 WDA 的每秒缩放倍率
      await wdaPinch(port, input.scale, 1 / (input.duration ?? 0.4));
      return {};
    case 'button':
      await wdaPressButton(port, input.name);
      return {};
    case 'appSwitcher':
      await wdaAppSwitcher(port);
      return {};
    case 'screen':
      if (input.on) await wdaUnlock(port);
      else await wdaLock(port);
      return { screenUnlocked: input.on };
    case 'screenToggle': {
      if (screenUnlocked) await wdaLock(port);
      else await wdaUnlock(port);
      return { screenUnlocked: !screenUnlocked };
    }
    case 'mute':
      // iOS 没有静音接口，连续按音量减到 0
      for (let i = 0; i < 10; i += 1) {
        await wdaPressButton(port, 'volumeDown');
      }
      return {};
    case 'text':
      await wdaTypeText(port, input.text);
      return {};
    default:
      return {};
  }
}
