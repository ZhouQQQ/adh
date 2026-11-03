import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  BUILTIN_AGENT_ID,
  FRAME_KIND,
  encodeFrame,
  parseViewerMessage,
  type DeviceControlInfo,
  type DeviceSummary,
  type StreamReady,
  type ViewerToStreamMessage,
} from '@adh/protocol';
import {
  ScrcpyControlTranslator,
  ScrcpySession,
  normalizeQuality,
  resolveQuality,
  type StreamQuality,
} from '@adh/device-host';
import type { AuthUser } from '../auth/service.js';
import type { Queries } from '../db/queries.js';
import type { DeviceLogService } from '../logs/device-logs.js';
import type { Logger } from '../log.js';
import type { AgentRegistry } from '../registry.js';
import type { WebHub } from '../ws/web-hub.js';

const IDLE_TIMEOUT_MS = 5 * 60_000;
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
  /** 当前控制者开始控制的时间 */
  controllerSince: number;
  /** 最近一次的控制者用户 id，刷新重连时用来恢复控制权 */
  controllerUserId: string | null;
  /** 控制者断开的时间 */
  controllerLeftAt: number;
  /** 是否允许其他人查看（默认允许，管理员不受限制） */
  allowViewers: boolean;
  agentSocket: WebSocket | null;
  local: LocalStream | null;
  meta: StreamReady | null;
  /** 最近一个关键帧，供中途加入的观看者立即解码 */
  lastKeyFrame: Uint8Array | null;
  idleTimer: NodeJS.Timeout | null;
  /** 控制者长时间无操作自动断开 */
  activityTimer: NodeJS.Timeout | null;
  agentTimer: NodeJS.Timeout | null;
  closed: boolean;
}

export interface StreamManagerDeps {
  queries: Queries;
  registry: AgentRegistry;
  hub: WebHub;
  logger: Logger;
  deviceLogs: DeviceLogService;
}

interface ViewerMeta {
  user?: AuthUser;
  ip?: string;
  lastTouch: number;
}

/** socket 对应的用户信息，用于写设备操作日志。 */
const viewerMeta = new WeakMap<WebSocket, ViewerMeta>();

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

  /** 当前正在控制设备的用户。 */
  getControl(deviceId: string): DeviceControlInfo | undefined {
    const session = this.findSessionByDevice(deviceId);
    if (!session?.controller) return undefined;
    const meta = viewerMeta.get(session.controller);
    if (!meta?.user) return undefined;
    return {
      userId: meta.user.id,
      username: meta.user.username,
      displayName: meta.user.displayName ?? undefined,
      since: session.controllerSince,
    };
  }

  /** 管理员强制断开某台设备的投屏会话。 */
  kickDevice(deviceId: string): boolean {
    const session = this.findSessionByDevice(deviceId);
    if (!session) return false;
    this.destroy(session.id, '管理员强制断开连接');
    return true;
  }

  /** 控制者开关「允许其他人查看」，管理员不受限制。 */
  setAllowViewers(
    deviceId: string,
    user: AuthUser,
    allow: boolean,
  ): boolean {
    const session = this.findSessionByDevice(deviceId);
    if (!session) return false;

    if (user.role !== 'admin') {
      const meta = session.controller
        ? viewerMeta.get(session.controller)
        : undefined;
      if (meta?.user?.id !== user.id) return false;
    }

    session.allowViewers = allow;

    if (!allow) {
      for (const viewer of [...session.viewers]) {
        if (viewer === session.controller) continue;
        const meta = viewerMeta.get(viewer);
        if (meta?.user?.role === 'admin') continue;
        sendJson(viewer, {
          t: 'error',
          message: '控制者已关闭其他人查看',
        });
        viewer.close();
      }
    }

    for (const viewer of session.viewers) {
      sendJson(viewer, { t: 'viewers', allow });
    }
    return true;
  }

  /** 控制者主动释放控制权；管理员也可以强制释放。 */
  releaseControl(deviceId: string, user: AuthUser): boolean {
    const session = this.findSessionByDevice(deviceId);
    if (!session) return false;

    const controller = session.controller;
    const meta = controller ? viewerMeta.get(controller) : undefined;
    if (user.role !== 'admin' && meta?.user?.id !== user.id) return false;

    session.controller = null;
    session.controllerUserId = null;
    session.controllerLeftAt = Date.now();
    if (session.activityTimer) {
      clearTimeout(session.activityTimer);
      session.activityTimer = null;
    }

    const payload = {
      t: 'control.released' as const,
      username: meta?.user?.username ?? user.username,
      displayName: meta?.user?.displayName ?? undefined,
    };
    for (const viewer of session.viewers) {
      if (viewer !== controller) sendJson(viewer, payload);
    }

    // 一直没人接管时按闲置回收
    this.scheduleIdleStop(session);
    this.notifyDevice(deviceId);
    return true;
  }

  /** 管理员把控制权从当前控制者手里接管过来。 */
  takeover(deviceId: string, user: AuthUser): boolean {
    const session = this.findSessionByDevice(deviceId);
    if (!session) return false;

    // 有人正在控制，或原控制者刚离开还没释放，只有管理员能抢
    if (session.controller && user.role !== 'admin') return false;
    if (!session.controller && session.controllerUserId && user.role !== 'admin') {
      return false;
    }

    const target = [...session.viewers].find(
      (viewer) => viewerMeta.get(viewer)?.user?.id === user.id,
    );
    if (!target || target === session.controller) return false;

    const previous = session.controller;
    session.controller = target;
    session.controllerSince = Date.now();
    session.controllerUserId = user.id;
    session.controllerLeftAt = 0;
    this.touchActivity(session);

    if (previous) sendJson(previous, { t: 'role', controller: false });
    sendJson(target, { t: 'role', controller: true });

    this.notifyDevice(deviceId);
    return true;
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

    const device = await this.deps.queries.getDevice(deviceId);
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
      controllerSince: 0,
      controllerUserId: null,
      controllerLeftAt: 0,
      allowViewers: true,
      agentSocket: null,
      local: null,
      meta: null,
      lastKeyFrame: null,
      idleTimer: null,
      activityTimer: null,
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

  attachViewer(
    sessionId: string,
    socket: WebSocket,
    user?: AuthUser,
    ip?: string,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      sendJson(socket, { t: 'error', message: '会话不存在或已结束' });
      socket.close();
      return;
    }

    // 控制者关闭查看后，普通用户不能加入；管理员不受限制
    const isAdmin = user?.role === 'admin';
    const isOwnController = Boolean(
      user && session.controllerUserId === user.id,
    );
    if (!session.allowViewers && !isAdmin && !isOwnController) {
      sendJson(socket, { t: 'error', message: '控制者已关闭其他人查看' });
      socket.close();
      return;
    }

    const previousController = session.controller;
    // 已有人控制时，只有原控制者本人重连才能恢复，其他人保持只读
    const sameUser = Boolean(user && session.controllerUserId === user.id);
    const becomesController =
      !previousController && (!session.controllerUserId || sameUser);

    session.viewers.add(socket);
    if (becomesController) {
      session.controller = socket;
      session.controllerSince = Date.now();
      session.controllerUserId = user?.id ?? null;
      session.controllerLeftAt = 0;
      this.touchActivity(session);
    }

    viewerMeta.set(socket, { user, ip, lastTouch: 0 });

    if (user) {
      void this.deps.deviceLogs.write({
        deviceId: session.device.id,
        deviceName: session.device.name,
        userId: user.id,
        username: user.username,
        action: becomesController ? 'control.start' : 'control.view',
        detail: becomesController ? '获得控制权' : '只读观看',
        ip,
      });
    }

    this.clearIdleTimer(session);

    if (session.meta) {
      sendJson(socket, session.meta);
      // 中途加入的观看者先补一个关键帧，避免等下一帧时黑屏
      if (session.lastKeyFrame) socket.send(session.lastKeyFrame);
    }
    sendJson(socket, {
      t: 'role',
      controller: session.controller === socket,
    });
    sendJson(socket, { t: 'viewers', allow: session.allowViewers });

    socket.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      this.handleViewerMessage(session, socket, raw.toString());
    });

    socket.on('close', () => {
      session.viewers.delete(socket);
      if (session.controller === socket) {
        session.controller = null;
        session.controllerLeftAt = Date.now();
        // 保留 controllerUserId：只有本人重连能恢复，其他观看者保持只读
        if (session.viewers.size === 0) {
          this.scheduleIdleStop(session);
        }
        this.notifyDevice(session.device.id);
        return;
      }
      if (session.viewers.size === 0) this.scheduleIdleStop(session);
    });
  }

  async attachAgent(sessionId: string, socket: WebSocket, token: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      socket.close();
      return;
    }
    const agent = await this.deps.queries.findAgentByToken(token);
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
    if (session.activityTimer) clearTimeout(session.activityTimer);
    session.activityTimer = null;
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
    void this.deps.queries.getDevice(deviceId).then((device) => {
      if (!device) return;
      this.deps.hub.broadcast({
        t: 'device.updated',
        device: {
          ...device,
          inUse: this.isInUse(deviceId),
          control: this.getControl(deviceId),
        },
      });
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

    this.touchActivity(session);

    const meta = viewerMeta.get(socket);
    if (meta) this.logViewerAction(session, meta, message);

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

  private logViewerAction(
    session: StreamSession,
    meta: ViewerMeta,
    message: ViewerToStreamMessage,
  ): void {
    const user = meta.user;
    if (!user) return;

    let action = '';
    let detail = '';

    switch (message.t) {
      case 'touch': {
        if (message.phase !== 'began') return;
        const now = Date.now();
        if (now - meta.lastTouch < 1200) return;
        meta.lastTouch = now;
        action = 'input.touch';
        detail = `(${message.x.toFixed(3)}, ${message.y.toFixed(3)})`;
        break;
      }
      case 'key':
        action = 'input.key';
        detail = message.key;
        break;
      case 'text':
        action = 'input.text';
        detail = `输入 ${message.text.length} 个字符`;
        break;
      case 'rotate':
        action = 'input.rotate';
        detail = '旋转屏幕';
        break;
      case 'screen':
        action = 'input.screen';
        detail = message.on ? '亮屏' : '息屏';
        break;
      case 'panel':
        action = 'input.panel';
        detail = message.panel === 'settings' ? '快捷设置' : '通知栏';
        break;
      default:
        return;
    }

    void this.deps.deviceLogs.write({
      deviceId: session.device.id,
      deviceName: session.device.name,
      userId: user.id,
      username: user.username,
      action,
      detail,
      ip: meta.ip,
    });
  }

  private broadcastBinary(
    session: StreamSession,
    payload: Uint8Array,
    _key = false,
  ): void {
    if (_key) session.lastKeyFrame = payload;
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

  /** 控制者有输入就重置无操作计时。 */
  private touchActivity(session: StreamSession): void {
    if (session.activityTimer) clearTimeout(session.activityTimer);
    session.activityTimer = setTimeout(() => {
      if (session.closed) return;
      this.destroy(session.id, '长时间无操作，已自动断开');
    }, IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(session: StreamSession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }
}