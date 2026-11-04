import WebSocket from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '@adh/device-host';
import {
  parseServerMessage,
  type AgentRuntimeInfo,
  type AgentToServerMessage,
  type DeviceInfo,
  type ServerToAgentMessage,
} from '@adh/protocol';
import type { Logger } from './log.js';
import { AgentStreamManager } from './stream-client.js';

export interface AgentClientOptions {
  serverUrl: string;
  token: string;
  runtime: AgentRuntimeInfo;
  logger: Logger;
  /** 设备扫描函数，便于测试替换。 */
  discover: () => Promise<DeviceInfo[]>;
  syncIntervalMs?: number;
}

function toAgentEndpoint(serverUrl: string): string {
  const withProtocol = serverUrl
    .replace(/^http:\/\//i, 'ws://')
    .replace(/^https:\/\//i, 'wss://');
  const url = new URL(withProtocol);
  url.pathname = '/ws/agent';
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
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopPeriodicSync();
    this.streams.stopAll();
    this.socket?.close(1000, 'agent shutdown');
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
      quality?: string;
    };

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
      );
    } else if (message.action === 'screen.stop' && params.sessionId) {
      this.streams.stop(params.sessionId);
    }

    this.send({ t: 'cmd.result', id: message.id, ok: true });
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