import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  BUILTIN_AGENT_ID,
  FRAME_KIND,
  encodeFrame,
  parseViewerMessage,
  type DeviceSummary,
  type StreamReady,
} from '@adh/protocol';
import {
  ScrcpyControlTranslator,
  ScrcpySession,
  normalizeQuality,
  resolveQuality,
  type StreamQuality,
} from '@adh/device-host';
import type { Queries } from '../db/queries.js';
import type { Logger } from '../log.js';
import type { AgentRegistry } from '../registry.js';
import type { WebHub } from '../ws/web-hub.js';

const IDLE_TIMEOUT_MS = 30_000;
const AGENT_ATTACH_TIMEOUT_MS = 15_000;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

interface LocalStream {
  scrcpy: ScrcpySession;
  translator: ScrcpyControlTranslator;
}

interface StreamSession {
  id: string;
  device: DeviceSummary;
  quality: StreamQuality;
  viewers: Set<WebSocket>;
  controller: WebSocket | null;
  agentSocket: WebSocket | null;
  local: LocalStream | null;
  meta: StreamReady | null;
  idleTimer: NodeJS.Timeout | null;
  agentTimer: NodeJS.Timeout | null;
  closed: boolean;
}

export interface StreamManagerDeps {
  queries: Queries;
  registry: AgentRegistry;
  hub: WebHub;
  logger: Logger;
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState === 1) socket.send(JSON.stringify(value));
}

/** 管理一路设备投屏会话：本地直连 scrcpy 或经远程 agent 中转。 */
export class StreamManager {
  private readonly sessions = new Map<string, StreamSession>();

  constructor(private readonly deps: StreamManagerDeps) {}

  /** 进程退出时清理所有会话。 */
  shutdown(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.destroy(sessionId, '服务端正在关闭');
    }
  }

  /** 该设备是否已有控制会话。 */
  isInUse(deviceId: string): boolean {
    return [...this.sessions.values()].some(
      (session) => session.device.id === deviceId && !session.closed,
    );
  }

  listInUseDeviceIds(): string[] {
    return [...this.sessions.values()]
      .filter((session) => !session.closed)
      .map((session) => session.device.id);
  }

  /** 同一台设备复用同一个会话，只有第一个 viewer 能控制。 */
  findSessionByDevice(deviceId: string): StreamSession | undefined {
    return [...this.sessions.values()].find(
      (session) => session.device.id === deviceId && !session.closed,
    );
  }

  async create(
    deviceId: string,
    quality: string = 'medium',
  ): Promise<{ sessionId: string }> {
    // 同一台设备复用已有会话：第二个进入的人只会拿到只读权限
    const reuse = this.findSessionByDevice(deviceId);
    if (reuse) return { sessionId: reuse.id };

    const device = this.deps.queries.getDevice(deviceId);
    if (!device) throw new Error('设备不存在');
    if (device.platform !== 'android') throw new Error('目前只支持 Android 投屏');

    const isBuiltin = device.agentId === BUILTIN_AGENT_ID;
    const live = this.deps.registry.get(device.agentId);
    if (!isBuiltin && !live) throw new Error('设备所在节点已离线');

    const sessionId = randomUUID();
    const session: StreamSession = {
      id: sessionId,
      device,
      quality: normalizeQuality(quality),
      viewers: new Set(),
      controller: null,
      agentSocket: null,
      local: null,
      meta: null,
      idleTimer: null,
      agentTimer: null,
      closed: false,
    };
    this.sessions.set(sessionId, session);

    if (isBuiltin) {
      void this.startLocal(session);
    } else {
      this.requestRemote(session, live!.socket);
    }

    this.notifyDevice(deviceId);
    return { sessionId };
  }

  /** 切换画质：先关掉旧会话，再按新档位重建。 */
  async restart(
    deviceId: string,
    quality: string = 'medium',
  ): Promise<{ sessionId: string }> {
    const existing = this.findSessionByDevice(deviceId);
    if (existing) this.destroy(existing.id, '切换画质');
    return this.create(deviceId, quality);
  }

  attachViewer(sessionId: string, socket: WebSocket): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      sendJson(socket, { t: 'error', message: '会话不存在或已结束' });
      socket.close();
      return;
    }

    session.viewers.add(socket);
    if (!session.controller) session.controller = socket;

    this.clearIdleTimer(session);

    if (session.meta) {
      sendJson(socket, session.meta);
    }
    sendJson(socket, {
      t: 'role',
      controller: session.controller === socket,
    });

    socket.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      this.handleViewerMessage(session, socket, raw.toString());
    });

    socket.on('close', () => {
      session.viewers.delete(socket);
      if (session.controller === socket) {
        // 控制者离开时把控制权交给仍在观看的人（例如小窗），没人看才释放设备
        const next = [...session.viewers].find(
          (viewer) => viewer.readyState === 1,
        );
        if (next) {
          session.controller = next;
          sendJson(next, { t: 'role', controller: true });
          return;
        }
        this.destroy(session.id, '控制者已离开，设备已释放');
        return;
      }
      if (session.viewers.size === 0) this.scheduleIdleStop(session);
    });
  }

  attachAgent(sessionId: string, socket: WebSocket, token: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      socket.close();
      return;
    }
    const agent = this.deps.queries.findAgentByToken(token);
    if (!agent || agent.id !== session.device.agentId) {
      sendJson(socket, { t: 'error', message: '无效的 agent 凭证' });
      socket.close();
      return;
    }

    if (session.agentTimer) {
      clearTimeout(session.agentTimer);
      session.agentTimer = null;
    }
    session.agentSocket = socket;

    socket.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        this.broadcastBinary(session, raw);
        return;
      }
      const message = raw.toString();
      for (const viewer of session.viewers) {
        if (viewer.readyState === 1) viewer.send(message);
      }
      try {
        const parsed = JSON.parse(message) as { t?: string };
        if (parsed.t === 'ready') session.meta = parsed as StreamReady;
      } catch {
        /* 非 JSON 帧忽略 */
      }
    });

    socket.on('close', () => {
      session.agentSocket = null;
      this.destroy(sessionId, 'agent 连接已断开');
    });
  }

  destroy(sessionId: string, reason?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) return;
    session.closed = true;
    this.sessions.delete(sessionId);
    this.clearIdleTimer(session);
    if (session.agentTimer) clearTimeout(session.agentTimer);

    void session.local?.scrcpy.stop();

    if (!session.local) {
      const live = this.deps.registry.get(session.device.agentId);
      if (live) {
        sendJson(live.socket, {
          t: 'cmd',
          id: randomUUID(),
          deviceId: session.device.id,
          action: 'screen.stop',
          params: { sessionId, udid: session.device.udid },
        });
      }
    }

    for (const viewer of session.viewers) {
      if (viewer.readyState === 1) {
        if (reason) sendJson(viewer, { t: 'error', message: reason });
        viewer.close();
      }
    }
    session.viewers.clear();

    if (session.agentSocket && session.agentSocket.readyState === 1) {
      session.agentSocket.close();
    }

    this.notifyDevice(session.device.id);
    this.deps.logger.info({ sessionId, reason }, 'stream session closed');
  }

  private notifyDevice(deviceId: string): void {
    const device = this.deps.queries.getDevice(deviceId);
    if (!device) return;
    this.deps.hub.broadcast({
      t: 'device.updated',
      device: { ...device, inUse: this.isInUse(deviceId) },
    });
  }

  private async startLocal(session: StreamSession): Promise<void> {
    const { preset } = resolveQuality(session.quality);
    const scrcpy = new ScrcpySession({
      udid: session.device.udid,
      maxSize: preset.maxSize,
      maxFps: 30,
      bitrate: preset.bitrate,
      logger: this.deps.logger,
    });

    const translator = new ScrcpyControlTranslator(() => ({
      width: session.meta?.width ?? 0,
      height: session.meta?.height ?? 0,
    }));

    session.local = { scrcpy, translator };

    try {
      await scrcpy.start({
        onMeta: (meta) => {
          const ready: StreamReady = {
            t: 'ready',
            sessionId: session.id,
            platform: 'android',
            codec: 'h264',
            videoCodec: meta.codec,
            width: meta.width,
            height: meta.height,
            rotation: 0,
            description: Buffer.from(meta.description).toString('base64'),
          };
          session.meta = ready;
          for (const viewer of session.viewers) sendJson(viewer, ready);
        },
        onVideo: (data, key) => {
          this.broadcastBinary(
            session,
            encodeFrame(FRAME_KIND.h264, data),
            key,
          );
        },
        onError: (message) => {
          for (const viewer of session.viewers) {
            sendJson(viewer, { t: 'error', message });
          }
        },
        onClose: () => this.destroy(session.id, '设备投屏已结束'),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '启动投屏失败';
      this.deps.logger.warn({ err: message }, 'local stream failed');
      this.destroy(session.id, message);
    }
  }

  private requestRemote(session: StreamSession, agentSocket: WebSocket): void {
    this.deps.logger.info(
      { sessionId: session.id, udid: session.device.udid },
      'requesting remote stream',
    );
    sendJson(agentSocket, {
      t: 'cmd',
      id: randomUUID(),
      deviceId: session.device.id,
      action: 'screen.start',
      params: {
        sessionId: session.id,
        udid: session.device.udid,
        quality: session.quality,
      },
    });

    session.agentTimer = setTimeout(() => {
      if (session.agentSocket) return;
      this.destroy(session.id, '设备节点未在预期时间内建立投屏连接');
    }, AGENT_ATTACH_TIMEOUT_MS);
  }

  private handleViewerMessage(
    session: StreamSession,
    socket: WebSocket,
    raw: string,
  ): void {
    if (session.controller !== socket) return;

    const message = parseViewerMessage(raw);
    if (!message) return;

    try {
      if (session.local) {
        for (const payload of session.local.translator.translate(message)) {
          session.local.scrcpy.sendControl(payload);
        }
        return;
      }

      if (session.agentSocket && session.agentSocket.readyState === 1) {
        session.agentSocket.send(JSON.stringify(message));
      }
    } catch (error) {
      this.deps.logger.warn(
        { sessionId: session.id, err: String(error) },
        'control message failed',
      );
    }
  }

  private broadcastBinary(
    session: StreamSession,
    payload: Uint8Array,
    _key = false,
  ): void {
    for (const viewer of session.viewers) {
      if (viewer.readyState !== 1) continue;
      // 解码跟不上时丢弃该帧，避免延迟雪崩
      if (viewer.bufferedAmount > MAX_BUFFERED_BYTES) continue;
      viewer.send(payload);
    }
  }

  private scheduleIdleStop(session: StreamSession): void {
    this.clearIdleTimer(session);
    session.idleTimer = setTimeout(() => {
      this.destroy(session.id, '长时间无人观看，已自动关闭');
    }, IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(session: StreamSession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }
}