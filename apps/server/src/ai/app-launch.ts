import { BUILTIN_AGENT_ID, type DeviceSummary } from '@adh/protocol';
import { launchAndroidApp, runCommand } from '@adh/device-host';
import type { CommandBus } from '../command-bus.js';
import type { Logger } from '../log.js';

/**
 * “打开某个 App”的快速通道。
 *
 * Midscene 的做法是维护 appNameMapping（应用名 → 包名）后直接
 * `adb activateApp` / `ios launch`。这里在它基础上补充：
 * - Android 本机：映射不到时用 uiautomator dump 找桌面图标，直接 adb tap
 * - iOS 本机：用 `ios apps --list` 动态匹配中文名，再 `ios launch`
 * - 远程 Android：走 agent 的 app.launch 命令
 * 这样“打开共享商家端”这类自定义 App 不用等视觉模型逐步点击。
 */
export interface LaunchResult {
  name: string;
  packageName?: string;
  method: 'mapping' | 'desktop' | 'ios-list';
  /** true 表示点击/启动动作已经完成，调用方不要再启动一次。 */
  alreadyOpened: boolean;
  /**
   * 是否可以直接判定任务完成。
   * 包名映射、iOS bundle id、桌面同名图标都算明确目标；
   * 保留这个字段是为了以后接入更保守的启动方式。
   */
  trusted: boolean;
}

export interface LaunchDeps {
  device: DeviceSummary;
  name: string;
  commands: CommandBus;
  logger: Logger;
}

/** 参考 Midscene 的 defaultAppNameMapping，只保留常用项。 */
const COMMON_ANDROID_APPS: Record<string, string> = {
  微信: 'com.tencent.mm',
  qq: 'com.tencent.mobileqq',
  微博: 'com.sina.weibo',
  淘宝: 'com.taobao.taobao',
  京东: 'com.jingdong.app.mall',
  拼多多: 'com.xunmeng.pinduoduo',
  小红书: 'com.xingin.xhs',
  知乎: 'com.zhihu.android',
  高德地图: 'com.autonavi.minimap',
  百度地图: 'com.baidu.BaiduMap',
  美团: 'com.sankuai.meituan',
  大众点评: 'com.dianping.v1',
  饿了么: 'me.ele',
  携程: 'ctrip.android.view',
  12306: 'com.MobileTicket',
  铁路12306: 'com.MobileTicket',
  滴滴出行: 'com.sdu.didi.psnger',
  滴滴: 'com.sdu.didi.psnger',
  bilibili: 'tv.danmaku.bili',
  哔哩哔哩: 'tv.danmaku.bili',
  抖音: 'com.ss.android.ugc.aweme',
  快手: 'com.smile.gifmaker',
  腾讯视频: 'com.tencent.qqlive',
  爱奇艺: 'com.qiyi.video',
  优酷: 'com.youku.phone',
  网易云音乐: 'com.netease.cloudmusic',
  qq音乐: 'com.tencent.qqmusic',
  飞书: 'com.ss.android.lark',
  豆包: 'com.larus.nova',
  支付宝: 'com.eg.android.AlipayGphone',
  设置: 'com.android.settings',
  相机: 'com.android.camera',
  相册: 'com.miui.gallery',
  浏览器: 'com.android.browser',
  文件管理: 'com.android.documentsui',
  应用商店: 'com.xiaomi.market',
  万能遥控: 'com.duokan.phone.remotecontroller',
};

function normalizeAppName(value: string): string {
  return value
    .replace(/[「」“”"']/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

function cleanPrefix(task: string): string {
  return task
    .trim()
    .replace(/^(?:(?:请|帮我|麻烦|帮忙|麻烦你|请你)\s*)+/g, '')
    .trim();
}

const OPEN_APP_PATTERN =
  /^(打开|启动|进入|运行|open|launch)\s*[「“"']?([^，,。;；\n」”"']+)/i;

/** 从“帮我打开共享商家端”里取出应用名。 */
export function extractLaunchTarget(task: string): string | null {
  const cleaned = cleanPrefix(task);
  const match = OPEN_APP_PATTERN.exec(cleaned);
  if (!match) return null;

  let target = (match[2] ?? '')
    .replace(/^(一下|下)\s*/, '')
    .replace(/\s*(app|应用)\s*$/i, '')
    .trim();
  target = target
    .split(/[，,。;；]|然后|并|再|之后|接着|看一下|看看|查看/)
    .at(0)
    ?.trim() ?? '';

  // “打开蓝牙 / WiFi / 飞行模式”这种系统开关不是 App，交给视觉关卡处理
  if (
    !target ||
    target.length > 40 ||
    /蓝牙|wifi|wi-fi|飞行模式|热点|定位|亮度|音量|勿扰|开发者选项|usb调试|nfc/i.test(
      target,
    )
  ) {
    return null;
  }
  return target;
}

/** 任务是否只是“打开某个 App”，没有后续动作。 */
export function isLaunchOnlyTask(task: string): boolean {
  const cleaned = cleanPrefix(task);
  if (!OPEN_APP_PATTERN.test(cleaned)) return false;
  if (
    /登录|搜索|点击|输入|进入|关闭|查看|看一下|看看|滑动|然后|并|再|之后|接着/.test(
      cleaned,
    )
  ) {
    return false;
  }
  return !/[，,。;；]/.test(cleaned);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function launchAndroidPackage(
  device: DeviceSummary,
  packageName: string,
  commands: CommandBus,
): Promise<boolean> {
  if (device.agentId === BUILTIN_AGENT_ID) {
    return launchAndroidApp(device.udid, packageName);
  }
  const result = await commands.send(
    device.agentId,
    'app.launch',
    { udid: device.udid, package: packageName },
    device.id,
    20_000,
  );
  return result.ok;
}

function attrOf(tag: string, name: string): string {
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return match?.[1] ?? '';
}

function findDesktopNode(
  xml: string,
  name: string,
): { x: number; y: number } | null {
  const expected = normalizeAppName(name);
  let best: { x: number; y: number; score: number } | null = null;

  for (const match of xml.matchAll(/<node\b[^>]*>/g)) {
    const tag = match[0];
    const labels = [attrOf(tag, 'text'), attrOf(tag, 'content-desc')]
      .filter(Boolean)
      .map(normalizeAppName);
    if (labels.length === 0) continue;

    const exact = labels.some((label) => label === expected);
    const partial =
      expected.length >= 2 && labels.some((label) => label.includes(expected));
    if (!exact && !partial) continue;

    const bounds = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(
      attrOf(tag, 'bounds'),
    );
    if (!bounds) continue;
    const [, x1, y1, x2, y2] = bounds.map(Number);
    if (
      x1 === undefined ||
      y1 === undefined ||
      x2 === undefined ||
      y2 === undefined ||
      x2 <= x1 ||
      y2 <= y1
    ) {
      continue;
    }

    const score = exact ? 2 : 1;
    if (!best || score > best.score) {
      best = {
        x: Math.round((x1 + x2) / 2),
        y: Math.round((y1 + y2) / 2),
        score,
      };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

function parseFocusPackage(raw: string): string | null {
  const match = /mCurrentFocus=Window\{[^}]*?\s([A-Za-z][A-Za-z0-9_.]+)\//.exec(
    raw,
  );
  return match?.[1] ?? null;
}

/**
 * Android 本机：回桌面，dump 当前页图标文本，找到目标后直接 adb tap。
 * 不缓存包名：桌面快捷方式（小程序 / PWA）点击后 focus 的是宿主 App，
 * 缓存成宿主包名下次会打开错页面。
 */
async function openFromAndroidDesktop(
  device: DeviceSummary,
  name: string,
  logger: Logger,
): Promise<{ clicked: boolean; packageName?: string }> {
  const udid = device.udid;
  const home = await runCommand(
    'adb',
    ['-s', udid, 'shell', 'input', 'keyevent', 'KEYCODE_HOME'],
    5_000,
  );
  if (home.failedToStart) return { clicked: false };
  await sleep(500);

  const dump = await runCommand(
    'adb',
    ['-s', udid, 'shell', 'uiautomator', 'dump', '/sdcard/adh-ui.xml'],
    15_000,
  );
  if (dump.code !== 0) return { clicked: false };

  const read = await runCommand(
    'adb',
    ['-s', udid, 'shell', 'cat', '/sdcard/adh-ui.xml'],
    10_000,
  );
  if (read.code !== 0) return { clicked: false };

  const point = findDesktopNode(read.stdout, name);
  if (!point) return { clicked: false };

  await runCommand(
    'adb',
    ['-s', udid, 'shell', 'input', 'tap', String(point.x), String(point.y)],
    5_000,
  );
  // App 启动动画 / 小程序加载需要一点时间，等 focus 稳定后再读包名
  await sleep(1_500);

  const focus = await runCommand(
    'adb',
    ['-s', udid, 'shell', 'dumpsys', 'window'],
    10_000,
  );
  const packageName =
    focus.code === 0 ? parseFocusPackage(focus.stdout) : null;
  logger.info(
    { deviceId: device.id, name, packageName, point },
    'ai desktop launch',
  );
  if (!packageName || /launcher|(^|\.)home($|\.)/i.test(packageName)) {
    // 点到文件夹 / 没打开目标，交给视觉继续处理
    return { clicked: false };
  }
  return { clicked: true, packageName };
}

let iosCliCache: { at: number; command: string | null } | null = null;

async function detectIosCli(): Promise<string | null> {
  if (iosCliCache && Date.now() - iosCliCache.at < 60_000) {
    return iosCliCache.command;
  }
  let command: string | null = null;
  for (const candidate of ['ios', 'go-ios']) {
    const probe = await runCommand(candidate, ['version'], 5_000);
    if (!probe.failedToStart) {
      command = candidate;
      break;
    }
  }
  iosCliCache = { at: Date.now(), command };
  return command;
}

function parseIosApps(
  raw: string,
): Array<{ bundleId: string; label: string }> {
  const apps: Array<{ bundleId: string; label: string }> = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^[A-Za-z0-9_.-]+\s+/.test(trimmed)) continue;
    const parts = trimmed.split(/\s+/);
    const bundleId = parts[0];
    if (!bundleId) continue;
    const hasVersion = parts.length > 2;
    const label = hasVersion
      ? parts.slice(1, -1).join(' ')
      : (parts[1] ?? '');
    apps.push({ bundleId, label });
  }
  return apps;
}

async function launchIosByName(
  device: DeviceSummary,
  name: string,
  logger: Logger,
): Promise<LaunchResult | null> {
  // 远程 iOS agent 目前没有 app.list / launch-by-name 命令，回退视觉
  if (device.agentId !== BUILTIN_AGENT_ID) return null;

  const cli = await detectIosCli();
  if (!cli) return null;

  // 任务里直接给 bundle id 时不用先拉应用列表
  if (/^[A-Za-z][A-Za-z0-9_.-]+$/.test(name) && name.includes('.')) {
    const launched = await runCommand(
      cli,
      ['launch', name, `--udid=${device.udid}`],
      30_000,
    );
    if (launched.code === 0) {
      return {
        name,
        packageName: name,
        method: 'ios-list',
        alreadyOpened: true,
        trusted: true,
      };
    }
  }

  const list = await runCommand(
    cli,
    ['apps', '--list', `--udid=${device.udid}`],
    60_000,
  );
  if (list.code !== 0) return null;

  const expected = normalizeAppName(name);
  const apps = parseIosApps(list.stdout);
  const target = apps.find((app) => {
    const label = normalizeAppName(app.label);
    return label === expected || label.includes(expected);
  });
  if (!target) return null;

  const launched = await runCommand(
    cli,
    ['launch', target.bundleId, `--udid=${device.udid}`],
    30_000,
  );
  if (launched.code !== 0) return null;

  logger.info(
    { deviceId: device.id, name, bundleId: target.bundleId },
    'ai ios launch',
  );
  return {
    name,
    packageName: target.bundleId,
    method: 'ios-list',
    alreadyOpened: true,
    trusted: true,
  };
}

/** 匹配到可启动的 App 时返回结果；匹配不到返回 null，让调用方走视觉。 */
export async function launchAppByName(
  deps: LaunchDeps,
): Promise<LaunchResult | null> {
  const { device, name } = deps;
  const normalized = normalizeAppName(name);

  if (device.platform === 'android') {
    // 任务里直接给包名时优先按包名启动
    if (/^[A-Za-z][A-Za-z0-9_.]+$/.test(name) && name.includes('.')) {
      const ok = await launchAndroidPackage(device, name, deps.commands);
      if (ok) {
        return {
          name,
          packageName: name,
          method: 'mapping',
          alreadyOpened: false,
          trusted: true,
        };
      }
    }

    const mapped = COMMON_ANDROID_APPS[normalized];
    if (mapped) {
      const ok = await launchAndroidPackage(device, mapped, deps.commands);
      if (ok) {
        return {
          name,
          packageName: mapped,
          method: 'mapping',
          alreadyOpened: false,
          trusted: true,
        };
      }
    }

    if (device.agentId === BUILTIN_AGENT_ID) {
      const opened = await openFromAndroidDesktop(
        device,
        name,
        deps.logger,
      );
      if (opened.clicked) {
        return {
          name,
          packageName: opened.packageName,
          method: 'desktop',
          alreadyOpened: true,
          // 点击的是用户桌面上的同名图标，打开的就是目标（即使它是小程序
          // 快捷方式，界面也是目标本身），可以认为启动成功。
          trusted: true,
        };
      }
    }
    return null;
  }

  return launchIosByName(device, name, deps.logger);
}