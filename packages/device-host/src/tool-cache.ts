import { resetIosDiscoverCommandCache } from './ios-discover.js';
import { resetMjpegCommandCache } from './ios-mjpeg.js';
import { resetTunnelCommandCache } from './ios-tunnel.js';
import { resetWdaRunnerCommandCache } from './ios-wda-runner.js';
import { resetWdaCommandCache } from './ios-wda.js';

/**
 * 安装 / 更新 adb、go-ios 之后调用。
 * 各模块会缓存「是否找到可执行文件」，不清掉的话最长 60 秒内仍按未安装处理。
 */
export function resetToolCommandCaches(): void {
  resetIosDiscoverCommandCache();
  resetTunnelCommandCache();
  resetWdaCommandCache();
  resetWdaRunnerCommandCache();
  resetMjpegCommandCache();
}