import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  adbInputText,
  captureScreenshot,
  detectAgentCapabilities,
  ensureToolPath,
  getTunnelStatus,
  installAndroidTools,
  installGoIos,
  launchAndroidApp,
  resetToolCommandCaches,
  runCommand,
  startTunnel,
  startWda,
  stopTunnel,
  stopWda,
  wdaApplyMjpegSettings,
  wdaScreenshot,
  wdaWindow,
  wdaPortFor,
  wdaStatus,
} from '@adh/device-host';
import {
  parseServerMessage,
  type AgentRuntimeInfo,
  type AgentToServerMessage,
  type DeviceInfo,
  type ServerToAgentMessage,
} from '@adh/protocol';
import type { Logger } from './log.js';
import { AgentStreamManager } from './stream-client.js';
import { VENDOR_DIR } from './tools.js';

export interface AgentClientOptions {
  serverUrl: string;
  token: string;
  runtime: AgentRuntimeInfo;
  logger: Logger;
  /** 设备扫描函数，便于测试替换。 */
  discover: () => Promise<DeviceInfo[]>;
  syncIntervalMs?: number;
  /** 被服务端要求停止（key 失效 / 被新实例替换）时回调，便于 CLI 退出进程。 */
  onStopped?: () => void;
}

/** 保留 --server 里的路径前缀，例如 ws://host:8080/adh → /adh/ws/agent */
function withServerPath(pathname: string, suffix: string): string {
  const prefix = pathname.replace(/\/+$/, '');
  return `${prefix}${suffix}`;
}

function toAgentEndpoint(serverUrl: string): string {
  const withProtocol = serverUrl
    .replace(/^http:\/\//i, 'ws://')
    .replace(/^https:\/\//i, 'wss://');
  const url = new URL(withProtocol);
  url.pathname = withServerPath(url.pathname, '/ws/agent');
  url.search = '';
  return url.toString();
}

function sameDevice(a: DeviceInfo, b: DeviceInfo): boolean {
  return (
    a.name === b.name &&
    a.model === b.model &&
    a.osVersion === b.osVersion &&
    a.rooted === b.rooted &&
    a.status === b.status &&
    a.wdaPort === b.wdaPort &&
    a.resolution?.width === b.resolution?.width &&
    a.resolution?.height === b.resolution?.height &&
    JSON.stringify(a.capabilities) === JSON.stringify(b.capabilities) &&
    JSON.stringify(a.tags) === JSON.stringify(b.tags)
  );
}

export class AgentClient {
  private readonly options: AgentClientOptions;
  private readonly streams: AgentStreamManager;
  private token: string;
  private socket: WebSocket | null = null;
  private synced = new Map<string, DeviceInfo>();
  private firstSync = true;
  /** 每 3 次扫描上报一次 iOS 隧道状态，约 15 秒。 */
  private statusTick = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private syncing = false;

  constructor(options: AgentClientOptions) {
    this.options = options;
    this.token = options.token;
    this.streams = new AgentStreamManager(
      options.serverUrl,
      options.token,
      options.logger,
    );
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** 当前已上报的设备快照，供缩略图循环使用。 */
  currentDevices(): DeviceInfo[] {
    return [...this.synced.values()];
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopPeriodicSync();
    this.streams.stopAll();
    this.socket?.close(1000, 'agent shutdown');
    this.options.onStopped?.();
  }

  private connect(): void {
    const endpoint = toAgentEndpoint(this.options.serverUrl);
    this.options.logger.info({ endpoint }, 'connecting');
    const socket = new WebSocket(endpoint);
    this.socket = socket;

    socket.on('open', () => {
      this.options.logger.info('connected, sending hello');
      this.send({ t: 'hello', token: this.token, agent: this.options.runtime });
    });

    socket.on('message', (raw: Buffer) => {
      const message = parseServerMessage(raw.toString());
      if (!message) return;
      this.handleServerMessage(message);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      this.stopPeriodicSync();
      this.options.logger.warn(
        { code, reason: reason.toString() },
        'connection closed',
      );
      this.scheduleReconnect();
    });

    socket.on('error', (error: Error) => {
      this.options.logger.debug({ err: error.message }, 'socket error');
    });
  }

  private handleServerMessage(message: ServerToAgentMessage): void {
    if (message.t === 'welcome') {
      this.reconnectAttempt = 0;
      this.options.logger.info(
        { agentId: message.agentId, serverVersion: message.serverVersion },
        'registered',
      );
      // 重连后 server 已把设备标记为离线，需要重新全量上报
      this.synced.clear();
      this.startPeriodicSync();
      return;
    }
    if (message.t === 'ping') {
      this.send({ t: 'pong', ts: Date.now() });
      return;
    }
    if (message.t === 'stop') {
      this.options.logger.warn({ reason: message.reason }, 'server stopped session');
      // key 失效或被同一 agent 的新实例替换：停止重连，避免两个实例互踢
      const reason = message.reason ?? '';
      if (reason === 'invalid key' || reason.includes('replaced')) {
        this.stop();
      }
      return;
    }
    if (message.t === 'cmd') {
      this.handleCommand(message);
    }
  }

  private handleCommand(
    message: Extract<ServerToAgentMessage, { t: 'cmd' }>,
  ): void {
    const params = (message.params ?? {}) as {
      sessionId?: string;
      udid?: string;
      url?: string;
      package?: string;
      quality?: string;
      platform?: string;
      restart?: boolean;
      name?: string;
      data?: string;
      bundleId?: string;
      container?: string;
      text?: string;
      android?: boolean;
      ios?: boolean;
      force?: boolean;
    };

    if (
      message.action === 'ios.tunnel.start' ||
      message.action === 'ios.tunnel.stop' ||
      message.action === 'ios.tunnel.status'
    ) {
      const action = message.action;
      void (async () => {
        try {
          const status =
            action === 'ios.tunnel.start'
              ? await startTunnel()
              : action === 'ios.tunnel.stop'
                ? await stopTunnel()
                : await getTunnelStatus();
          this.send({
            t: 'cmd.result',
            id: message.id,
            ok: action === 'ios.tunnel.start' ? status.running : true,
            error:
              action === 'ios.tunnel.start' && !status.running
                ? status.error ?? 'iOS 隧道启动失败'
                : undefined,
            data: { status },
          });
          // 控制台「节点管理」立即刷新隧道状态
          this.send({ t: 'agent.status', tunnel: status });
        } catch (error) {
          this.send({
            t: 'cmd.result',
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      return;
    }

    if (message.action === 'agent.tools.install') {
      void (async () => {
        try {
          const android = params.android === true;
          const ios = params.ios === true;
          if (!android && !ios) throw new Error('请选择要安装的工具');

          const logs: string[] = [];
          const log = (line: string): void => {
            logs.push(line);
          };
          const results: { kind: string; ok: boolean; error?: string }[] = [];

          if (android) {
            const result = await installAndroidTools({
              force: params.force === true,
              vendorDir: VENDOR_DIR,
              log,
            });
            results.push({ kind: 'adb', ok: result.ok, error: result.error });
          }
          if (ios) {
            const result = await installGoIos({
              force: params.force === true,
              vendorDir: VENDOR_DIR,
              log,
            });
            results.push({ kind: 'go-ios', ok: result.ok, error: result.error });
          }

          // 新装的可执行文件立刻生效：刷新 PATH 并清掉各模块的命令缓存
          ensureToolPath();
          resetToolCommandCaches();
          const capabilities = await detectAgentCapabilities();
          const status = await getTunnelStatus();
          const error = results.find((item) => !item.ok)?.error;

          this.send({
            t: 'cmd.result',
            id: message.id,
            ok: !error,
            error,
            data: { capabilities, results, logs },
          });
          this.send({ t: 'agent.status', tunnel: status, capabilities });
        } catch (error) {
          this.send({
            t: 'cmd.result',
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      return;
    }

    if (
      message.action === 'gallery.import' &&
      params.udid &&
      params.name &&
      params.data
    ) {
      const { udid, name, data } = params;
      void (async () => {
        const temp = path.join(os.tmpdir(), `adh-gallery-${Date.now()}-${name}`);
        try {
          fs.writeFileSync(temp, Buffer.from(data, 'base64'));
          const remotePath = `/sdcard/Pictures/${name}`;
          const push = await runCommand(
            'adb',
            ['-s', udid, 'push', temp, remotePath],
            120_000,
          );
          if (push.code !== 0) {
            throw new Error(push.stderr.trim() || '推送图片失败');
          }
          // 让系统媒体库立即索引，相册里马上能看到
          await runCommand(
            'adb',
            [
              '-s',
              udid,
              'shell',
              'am',
              'broadcast',
              '-a',
              'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
              '-d',
              `file://${remotePath}`,
            ],
            20_000,
          );
          this.send({
            t: 'cmd.result',
            id: message.id,
            ok: true,
            data: { path: remotePath },
          });
        } catch (error) {
          this.send({
            t: 'cmd.result',
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          fs.rmSync(temp, { force: true });
        }
      })();
      return;
    }

    if (
      message.action === 'ios.file.push' &&
      params.udid &&
      params.name &&
      params.data &&
      (params.container === 'documents' || params.container === 'temp')
    ) {
      const { udid, name, data, container, bundleId } = params;
      void (async () => {
        const temp = path.join(os.tmpdir(), `adh-appfile-${Date.now()}-${name}`);
        try {
          if (container === 'documents' && !bundleId) {
            throw new Error('缺少 App Bundle ID');
          }
          fs.writeFileSync(temp, Buffer.from(data, 'base64'));
          const args =
            container === 'temp'
              ? [
                  'file',
                  'push',
                  '--temp',
                  `--local=${temp}`,
                  `--remote=${name}`,
                  `--udid=${udid}`,
                ]
              : [
                  'file',
                  'push',
                  `--app=${bundleId}`,
                  `--local=${temp}`,
                  `--remote=Documents/${name}`,
                  `--udid=${udid}`,
                ];
          const result = await this.runIosCommand(args, 120_000);
          if (result.code !== 0) {
            throw new Error(
              result.stderr.trim() || result.stdout.trim() || '推送文件失败',
            );
          }
          this.send({
            t: 'cmd.result',
            id: message.id,
            ok: true,
            data: {
              path:
                container === 'temp'
                  ? `tmp/${name}`
                  : `Documents/${name}`,
            },
          });
        } catch (error) {
          this.send({
            t: 'cmd.result',
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          fs.rmSync(temp, { force: true });
        }
      })();
      return;
    }

    if (message.action === 'input.text') {
      const udid = params.udid;
      const text = params.text;
      if (udid && typeof text === 'string') {
        void (async () => {
          try {
            await adbInputText(udid, text);
            this.send({
              t: 'cmd.result',
              id: message.id,
              ok: true,
              data: { method: 'adb' },
            });
          } catch (error) {
            this.send({
              t: 'cmd.result',
              id: message.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        })();
        return;
      }
    }

    if (message.action === 'ios.status' && params.udid) {
      void wdaStatus(wdaPortFor(params.udid))
        .then((status) => {
          this.send({
            t: 'cmd.result',
            id: message.id,
            ok: true,
            data: { status },
          });
        })
        .catch((error: unknown) => {
          this.send({
            t: 'cmd.result',
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (message.action === 'ios.wda.start' && params.udid) {
      void startWda(params.udid, undefined, Boolean(params.restart))
        .then((result) => {
          this.send({
            t: 'cmd.result',
            id: message.id,
            ok: result.ok,
            error: result.ok ? undefined : result.message,
            data: { message: result.message, port: result.port },
          });
        })
        .catch((error: unknown) => {
          this.send({
            t: 'cmd.result',
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (message.action === 'ios.wda.stop' && params.udid) {
      void stopWda(params.udid)
        .then(() => {
          this.send({ t: 'cmd.result', id: message.id, ok: true });
        })
        .catch((error: unknown) => {
          this.send({
            t: 'cmd.result',
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (message.action === 'ios.quality' && params.udid && params.quality) {
      const settings =
        params.quality === 'low'
          ? { framerate: 30, quality: 25, scaling: 25 }
          : params.quality === 'high'
            ? { framerate: 30, quality: 75, scaling: 100 }
            : params.quality === 'ultra'
              ? { framerate: 30, quality: 95, scaling: 100 }
              : { framerate: 24, quality: 45, scaling: 50 };
      void wdaApplyMjpegSettings(wdaPortFor(params.udid), settings)
        .then(() => {
          this.send({ t: 'cmd.result', id: message.id, ok: true });
        })
        .catch((error: unknown) => {
          this.send({
            t: 'cmd.result',
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (message.action === 'screenshot' && params.udid) {
      const platform = params.platform === 'ios' ? 'ios' : 'android';
      void (async () => {
        try {
          if (platform === 'ios') {
            const port = wdaPortFor(params.udid!);
            const data = await wdaScreenshot(port);
            if (!data) throw new Error('WDA 截图失败');
            const size = await wdaWindow(port);
            this.send({
              t: 'cmd.result',
              id: message.id,
              ok: true,
              data: {
                base64: data.toString('base64'),
                width: size.width,
                height: size.height,
              },
            });
            return;
          }
          const shot = await captureScreenshot(params.udid!);
          if (!shot) throw new Error('adb 截图失败');
          this.send({
            t: 'cmd.result',
            id: message.id,
            ok: true,
            data: {
              base64: shot.data.toString('base64'),
              width: shot.width,
              height: shot.height,
            },
          });
        } catch (error) {
          this.send({
            t: 'cmd.result',
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      return;
    }

    if (message.action === 'app.launch' && params.udid && params.package) {
      void launchAndroidApp(params.udid, params.package)
        .then((ok) => {
          this.send({
            t: 'cmd.result',
            id: message.id,
            ok,
            error: ok ? undefined : '应用启动失败，请检查包名',
          });
        })
        .catch((error: unknown) => {
          this.send({
            t: 'cmd.result',
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (message.action === 'app.install' && params.udid && params.url) {
      void this.installApk(params.url, params.udid)
        .then((ok) => {
          this.send({
            t: 'cmd.result',
            id: message.id,
            ok,
            error: ok ? undefined : 'adb install 返回失败',
          });
        })
        .catch((error: unknown) => {
          this.send({
            t: 'cmd.result',
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return;
    }

    if (message.action === 'screen.start' && params.sessionId && params.udid) {
      void this.streams.start(
        params.sessionId,
        params.udid,
        typeof params.quality === 'string' ? params.quality : 'medium',
        params.platform === 'ios' ? 'ios' : 'android',
      );
    } else if (message.action === 'screen.stop' && params.sessionId) {
      this.streams.stop(params.sessionId);
    }

    this.send({ t: 'cmd.result', id: message.id, ok: true });
  }

  /** 依次尝试 ios / go-ios，避免不同安装方式下命令名不一致。 */
  private async runIosCommand(
    args: string[],
    timeoutMs = 60_000,
  ): Promise<Awaited<ReturnType<typeof runCommand>>> {
    for (const command of ['ios', 'go-ios']) {
      const result = await runCommand(command, args, timeoutMs);
      if (!result.failedToStart) return result;
    }
    throw new Error('未找到 go-ios（ios / go-ios）');
  }

  private async installApk(url: string, udid: string): Promise<boolean> {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) {
      throw new Error(`下载安装包失败 (${response.status})`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const tempPath = path.join(os.tmpdir(), `adh-${Date.now()}-${udid}.apk`);
    fs.writeFileSync(tempPath, buffer);

    try {
      const result = await runCommand(
        'adb',
        ['-s', udid, 'install', '-r', '-d', tempPath],
        300_000,
      );
      const ok = result.code === 0 && /success/i.test(result.stdout);
      if (!ok) {
        this.options.logger.warn(
          { udid, output: `${result.stdout}${result.stderr}`.trim() },
          'apk install failed',
        );
      }
      return ok;
    } finally {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* 临时文件已不存在 */
      }
    }
  }

  private send(message: AgentToServerMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private startPeriodicSync(): void {
    this.stopPeriodicSync();
    void this.syncNow();
    this.syncTimer = setInterval(
      () => void this.syncNow(),
      this.options.syncIntervalMs ?? 5_000,
    );
  }

  private stopPeriodicSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private async syncNow(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const devices = await this.options.discover();
      if (this.firstSync) {
        this.firstSync = false;
        this.options.logger.info(
          {
            total: devices.length,
            devices: devices.map((device) => `${device.platform}:${device.name}`),
          },
          '首次设备扫描完成',
        );
      }
      const next = new Map(devices.map((device) => [device.udid, device]));
      const add: DeviceInfo[] = [];
      const update: { udid: string; patch: Partial<DeviceInfo> }[] = [];
      const remove: string[] = [];

      for (const [udid, device] of next) {
        const previous = this.synced.get(udid);
        if (!previous) add.push(device);
        else if (!sameDevice(previous, device)) update.push({ udid, patch: device });
      }
      for (const udid of this.synced.keys()) {
        if (!next.has(udid)) {
          // 设备从 adb 消失：上报离线而不是删除，控制台仍能看到它
          update.push({ udid, patch: { status: 'offline' } });
        }
      }

      if (add.length || update.length || remove.length) {
        this.send({ t: 'devices.sync', add, remove, update });
        this.options.logger.info(
          { added: add.length, updated: update.length, removed: remove.length },
          'devices synced',
        );
      }
      this.synced = next;

      // 定期上报节点级 iOS 隧道状态，控制台「节点管理」会显示
      if (this.statusTick % 3 === 0) {
        void getTunnelStatus()
          .then((tunnel) => this.send({ t: 'agent.status', tunnel }))
          .catch(() => undefined);
      }
      this.statusTick += 1;
    } catch (error) {
      this.options.logger.warn({ err: String(error) }, 'device scan failed');
    } finally {
      this.syncing = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectAttempt - 1, 5));
    this.options.logger.info({ delayMs: delay }, 'will reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }
}
