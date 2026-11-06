import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  goIosDir,
  managedGoIosBinary,
  runCommand,
} from '@adh/device-host';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  platform: string;
  checks: DoctorCheck[];
}

function probeTcp(host: string, port: number, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function findGoIos(): Promise<{ command: string; version: string } | null> {
  for (const command of ['go-ios', 'ios']) {
    const result = await runCommand(command, ['version'], 5_000);
    if (!result.failedToStart) {
      const text = (result.stdout || result.stderr).trim().split(/\r?\n/)[0] ?? '';
      return { command, version: text };
    }
  }
  return null;
}

export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const platform = process.platform;

  const adb = await runCommand('adb', ['version'], 5_000);
  if (adb.failedToStart) {
    checks.push({
      name: 'ADB',
      ok: false,
      detail: '未找到 adb 可执行文件',
      hint: '安装 Android Platform Tools 并把 platform-tools 目录加入 PATH',
    });
  } else {
    const line = adb.stdout.split(/\r?\n/).find((l) => l.startsWith('Android Debug Bridge'));
    checks.push({
      name: 'ADB',
      ok: adb.code === 0,
      detail: line ?? (adb.stdout.trim() || 'adb 已安装但无法执行'),
    });
  }

  const goIos = await findGoIos();
  checks.push(
    goIos
      ? { name: 'go-ios', ok: true, detail: `${goIos.command} · ${goIos.version}` }
      : {
          name: 'go-ios',
          ok: false,
          detail: '未安装',
          hint: 'iOS 设备发现与 WDA 启动依赖 go-ios，见 M1 阶段说明',
        },
  );

  if (platform === 'win32') {
    // go-ios 的 wintun 绑定会先搜 exe 目录，再搜 System32；
    // 打包版会把 dll 放在 ~/.adh/tools/go-ios，无需管理员。
    const managed = managedGoIosBinary();
    const candidates = [
      managed ? path.join(path.dirname(managed), 'wintun.dll') : null,
      path.join(goIosDir(), 'wintun.dll'),
      path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'wintun.dll',
      ),
    ].filter((file): file is string => Boolean(file));
    const found = candidates.find((file) => fs.existsSync(file));
    checks.push({
      name: 'wintun.dll',
      ok: Boolean(found),
      detail: found
        ? found
        : '未找到（iOS 17+ 内核隧道需要；缺失时自动回退 --userspace）',
      hint: found
        ? undefined
        : '运行 adh-agent init 可自动放到 go-ios 目录；也可手动复制到 go-ios 所在目录，或 C:\\Windows\\System32（需管理员）',
    });
  }

  const ideviceId = await runCommand('idevice_id', ['-l'], 5_000);
  checks.push(
    ideviceId.failedToStart
      ? {
          name: 'libimobiledevice',
          ok: false,
          detail: '未安装（可选，go-ios 可替代）',
        }
      : {
          name: 'libimobiledevice',
          ok: true,
          detail: `可用 · 当前 ${ideviceId.stdout.trim().split(/\r?\n/).filter(Boolean).length} 台 iOS 设备`,
        },
  );

  if (platform === 'win32' || platform === 'darwin') {
    const usbmuxd = await probeTcp('127.0.0.1', 27015);
    checks.push({
      name: 'Apple 设备服务',
      ok: usbmuxd,
      detail: usbmuxd ? 'usbmuxd 27015 可连接' : '127.0.0.1:27015 无法连接',
      hint: usbmuxd
        ? undefined
        : platform === 'win32'
          ? '安装 iTunes 或 Apple Devices，确保 Apple Mobile Device Service 正在运行'
          : '确认 usbmuxd 服务已启动',
    });
  }

  return { platform, checks };
}