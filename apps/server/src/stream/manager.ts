import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  BUILTIN_AGENT_ID,
  FRAME_KIND,
  encodeFrame,
  parseViewerMessage,
  type DeviceControlInfo,
  type DeviceSummary,
  type IosInput,
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
import { isAdminRole, type AuthUser } from '../auth/service.js';
import type { Queries } from '../db/queries.js';
import type { DeviceLogService } from '../logs/device-logs.js';
import type { Logger } from '../log.js';
import type { AgentRegistry } from '../registry.js';
import type { SettingsService } from '../settings/service.js';
import type { WebHub } from '../ws/web-hub.js';

/** 最后一个观看者离开后，保留会话等待重连的时间。 */
const VIEWER_IDLE_TIMEOUT_MS = 5 * 60_000;
/** 控制者异常掉线后给原用户的重连窗口，超时才允许其他人接管。 */
const CONTROLLER_RECONNECT_WINDOW_MS = 30_000;
const AGENT_ATTACH_TIMEOUT_MS = 15_000;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
/** iOS 没有 WebSocket 会话，用带心跳的控制权记录，超时自动释放。 */
const IOS_CONTROL_TTL_MS = 30_000;
/** 同一设备短时间内重复进入控制（刷新重连）只计一次使用。 */
const USAGE_DEDUPE_MS = 60_000;

interface IosControl {
  userId: string;
  username: string;
  displayName?: string;
  role: string;
  since: number;
  touchedAt: number;
}

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
  /** 控制者掉线后的重连窗口计时器 */
  controllerReleaseTimer: NodeJS.Timeout | null;
  /** 是否允许其他人查看（默认允许，管理员不受限制） */
  allowViewers: boolean;
  /** 设备是否被管理员锁定：普通用户不能控制也不能查看 */
  locked: boolean;
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
  settings: SettingsService;
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
  /** iOS 设备的控制权（无 WebSocket 会话，按心跳 + TTL 维护）。 */
  private readonly iosControls = new Map<string, IosControl>();
  /** 设备最近一次计入使用次数的时间，用于去重。 */
  private readonly usageRecordedAt = new Map<string, number>();
  /** AI 任务执行期间锁定的设备，普通 viewer 不能进来抢控制权。 */
  private readonly taskLocks = new Set<string>();

  constructor(private readonly deps: StreamManagerDeps) {}

  private liveIosControl(deviceId: string): IosControl | undefined {
    const entry = this.iosControls.get(deviceId);
    if (!entry) return undefined;
    if (Date.now() - entry.touchedAt > IOS_CONTROL_TTL_MS) {
      this.iosControls.delete(deviceId);
      // 过期释放也要通知前端，否则设备卡片会一直显示「使用中」
      this.notifyDevice(deviceId);
      return undefined;
    }
    return entry;
  }

  private toControlInfo(entry: IosControl): DeviceControlInfo {
    return {
      userId: entry.userId,
      username: entry.username,
      displayName: entry.displayName,
      role: entry.role,
      since: entry.since,
    };
  }

  /** iOS 申请控制权：同一时间只允许一个人控制。 */
  claimIosControl(
    deviceId: string,
    user: AuthUser,
  ): { granted: boolean; control?: DeviceControlInfo } {
    const existing = this.liveIosControl(deviceId);
    if (existing && existing.userId !== user.id) {
      return { granted: false, control: this.toControlInfo(existing) };
    }
    const entry: IosControl = existing ?? {
      userId: user.id,
      username: user.username,
      displayName: user.displayName ?? undefined,
      role: user.role,
      since: Date.now(),
      touchedAt: Date.now(),
    };
    entry.touchedAt = Date.now();
    this.iosControls.set(deviceId, entry);
    // 首次拿到控制权时记一次使用，并广播让其他端的设备卡片立即显示「谁在使用」
    if (!existing) void this.recordUsage(deviceId);
    return { granted: true, control: this.toControlInfo(entry) };
  }

  /** iOS 控制权心跳；返回 false 表示控制权已经不属于该用户。 */
  touchIosControl(deviceId: string, userId: string): boolean {
    const existing = this.liveIosControl(deviceId);
    if (!existing || existing.userId !== userId) return false;
    existing.touchedAt = Date.now();
    return true;
  }

  /** 进程退出时清理所有会话。 */
  shutdown(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.destroy(sessionId, '服务端正在关闭');
    }
  }

  /** AI 任务期间占用设备，阻止 viewer 接管。 */
  lockForTask(deviceId: string): void {
    this.taskLocks.add(deviceId);
  }

  unlockForTask(deviceId: string): void {
    this.taskLocks.delete(deviceId);
  }

  isTaskLocked(deviceId: string): boolean {
    return this.taskLocks.has(deviceId);
  }

  /** 等待投屏会话的 ready 元数据；任务执行前必须先确认画面通道就绪。 */
  async waitReady(deviceId: string, timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const session = this.findSessionByDevice(deviceId);
      if (!session || session.closed) return false;
      if (session.meta) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  }

  /** 该设备是否已有控制会话（含 iOS 的心跳式控制权）。 */
  isInUse(deviceId: string): boolean {
    if (this.liveIosControl(deviceId)) return true;
    return [...this.sessions.values()].some(
      (session) => session.device.id === deviceId && !session.closed,
    );
  }

  listInUseDeviceIds(): string[] {
    const ids = new Set(
      [...this.sessions.values()]
        .filter((session) => !session.closed)
        .map((session) => session.device.id),
    );
    // iOS 没有投屏会话，控制权只存在于 iosControls 里
    for (const deviceId of [...this.iosControls.keys()]) {
      if (this.liveIosControl(deviceId)) ids.add(deviceId);
    }
    return [...ids];
  }

  /** 当前正在控制设备的用户。 */
  getControl(deviceId: string): DeviceControlInfo | undefined {
    // iOS 的控制权独立于投屏会话，有 iosControl 就以它为准
    const ios = this.liveIosControl(deviceId);
    if (ios) return this.toControlInfo(ios);

    const session = this.findSessionByDevice(deviceId);
    if (!session || !session.controller) return undefined;
    const meta = viewerMeta.get(session.controller);
    if (!meta?.user) return undefined;
    return {
      userId: meta.user.id,
      username: meta.user.username,
      displayName: meta.user.displayName ?? undefined,
      role: meta.user.role,
      since: session.controllerSince,
    };
  }

  /* ------------------------------------------------------------------ */
/* 单点登录                                                            */
/* ------------------------------------------------------------------ */

  /** 同一账号在别处登录：断开该用户在所有投屏会话里的连接。 */
  kickUser(userId: string): void {
    for (const session of this.sessions.values()) {
      for (const viewer of [...session.viewers]) {
        if (viewerMeta.get(viewer)?.user?.id !== userId) continue;
        sendJson(viewer, { t: 'error', message: '账号已在其他位置登录' });
        viewer.close(4001, '账号已在其他位置登录');
        session.viewers.delete(viewer);
      }
      if (session.controller && !session.viewers.has(session.controller)) {
        session.controller = null;
        session.controllerUserId = null;
        session.controllerLeftAt = Date.now();
        this.clearControllerRelease(session);
      }
      this.broadcastViewerList(session);
    }
  }

  /** 该用户此时进入设备是否会成为控制者（只读观看不算）。 */
  willBecomeController(deviceId: string, userId: string): boolean {
    const session = this.findSessionByDevice(deviceId);
    if (!session) {
      const ios = this.liveIosControl(deviceId);
      return !ios || ios.userId === userId;
    }
    if (session.controller) return false;
    // 控制权空悬时只有原控制者本人能恢复
    return !session.controllerUserId || session.controllerUserId === userId;
  }

  /** 同一用户当前正在控制的设备数。 */
  countControlledDevices(userId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.closed || !session.controller) continue;
      const meta = viewerMeta.get(session.controller);
      if (meta?.user?.id === userId) count += 1;
    }
    const now = Date.now();
    for (const entry of this.iosControls.values()) {
      if (now - entry.touchedAt <= IOS_CONTROL_TTL_MS && entry.userId === userId) {
        count += 1;
      }
    }
    return count;
  }

  /** 管理员强制断开某台设备的投屏会话。 */
  kickDevice(
    deviceId: string,
    user: AuthUser,
    reason = '管理员强制断开连接',
  ): boolean {
    const session = this.findSessionByDevice(deviceId);
    if (!session) {
      const ios = this.liveIosControl(deviceId);
      if (!ios) return false;
      // 管理员不能断开超级管理员
      if (ios.role === 'superadmin' && user.role !== 'superadmin') return false;
      this.iosControls.delete(deviceId);
      this.notifyDevice(deviceId);
      return true;
    }

    const meta = session.controller
      ? viewerMeta.get(session.controller)
      : undefined;
    if (meta?.user?.role === 'superadmin' && user.role !== 'superadmin') {
      return false;
    }

    this.destroy(session.id, reason);
    return true;
  }

  /**
   * 设置设备锁定状态：锁定后断开所有会话（管理员也不例外），
   * 解锁前任何人都不能控制或查看。
   */
  setLocked(deviceId: string, locked: boolean): void {
    const session = this.findSessionByDevice(deviceId);
    if (!session) {
      // iOS 没有投屏会话：锁定时同步收回控制权，解锁后重新申请
      if (locked && this.iosControls.delete(deviceId)) this.notifyDevice(deviceId);
      return;
    }
    session.locked = locked;
    if (!locked) return;

    for (const viewer of [...session.viewers]) {
      sendJson(viewer, { t: 'error', message: '设备已被管理员锁定' });
      viewer.close(4004, '设备已被管理员锁定');
      session.viewers.delete(viewer);
    }

    if (session.controller && !session.viewers.has(session.controller)) {
      session.controller = null;
      session.controllerUserId = null;
      session.controllerLeftAt = Date.now();
      this.clearControllerRelease(session);
    }
  }

  /** 无会话设备（iOS）的查看开关：谁能看由 owner 控制。 */
  private readonly deviceViewers = new Map<
    string,
    { allow: boolean; owner: string | null }
  >();

  /** iOS 等无会话设备是否允许其他人查看（原始值，未按角色过滤）。 */
  getAllowViewers(deviceId: string): boolean {
    return this.deviceViewers.get(deviceId)?.allow ?? true;
  }

  /** iOS 等无会话设备是否允许其他人查看。 */
  isViewersAllowed(
    deviceId: string,
    userId?: string,
    role?: string,
  ): boolean {
    const entry = this.deviceViewers.get(deviceId);
    if (!entry || entry.allow) return true;
    if (role === 'admin' || role === 'superadmin') return true;
    return entry.owner === userId;
  }

  /** 控制者开关「允许其他人查看」，管理员不受限制。 */
  setAllowViewers(
    deviceId: string,
    user: AuthUser,
    allow: boolean,
  ): boolean {
    const session = this.findSessionByDevice(deviceId);
    if (!session) {
      // iOS 没有投屏会话：只有当前控制者或管理员能改
      const ios = this.liveIosControl(deviceId);
      if (!isAdminRole(user.role) && ios?.userId !== user.id) return false;
      this.deviceViewers.set(deviceId, { allow, owner: user.id });
      // 广播给所有 Web 客户端，只读用户的页面可以立即显示/隐藏
      this.notifyDevice(deviceId);
      return true;
    }

    if (!isAdminRole(user.role)) {
      const meta = session.controller
        ? viewerMeta.get(session.controller)
        : undefined;
      if (meta?.user?.id !== user.id) return false;
    }

    session.allowViewers = allow;

    for (const viewer of session.viewers) {
      sendJson(viewer, { t: 'viewers', allow });
    }

    // 重新开启时补一个关键帧，观看者画面可以立即恢复
    if (allow && session.lastKeyFrame) {
      for (const viewer of session.viewers) {
        if (viewer === session.controller) continue;
        if (viewer.readyState === 1) viewer.send(session.lastKeyFrame);
      }
    }

    this.notifyDevice(deviceId);
    return true;
  }

  /** 控制者主动释放控制权；管理员也可以强制释放。 */
  releaseControl(deviceId: string, user: AuthUser): boolean {
    const session = this.findSessionByDevice(deviceId);
    if (!session) {
      const ios = this.liveIosControl(deviceId);
      if (!ios) return false;
      // 管理员不能断开超级管理员
      if (ios.role === 'superadmin' && user.role !== 'superadmin') return false;
      if (!isAdminRole(user.role) && ios.userId !== user.id) return false;
      this.iosControls.delete(deviceId);
      this.notifyDevice(deviceId);
      return true;
    }

    const controller = session.controller;
    const meta = controller ? viewerMeta.get(controller) : undefined;
    if (meta?.user?.role === 'superadmin' && user.role !== 'superadmin') {
      return false;
    }
    if (!isAdminRole(user.role) && meta?.user?.id !== user.id) return false;

    session.controller = null;
    session.controllerUserId = null;
    session.controllerLeftAt = Date.now();
    this.clearControllerRelease(session);
    if (session.activityTimer) {
      clearTimeout(session.activityTimer);
      session.activityTimer = null;
    }

    const payload = {
      t: 'control.released' as const,
      username: meta?.user?.username ?? user.username,
      displayName: meta?.user?.displayName ?? undefined,
    };
    // 原控制者也要收到，前端据此把自己切回只读（页面不跳转）
    for (const viewer of session.viewers) {
      if (viewer.readyState === 1) sendJson(viewer, payload);
    }
    this.broadcastViewerList(session);

    // 一直没人接管时按闲置回收
    this.scheduleIdleStop(session);
    this.notifyDevice(deviceId);
    return true;
  }

  /** 管理员把控制权从当前控制者手里接管过来。 */
  takeover(deviceId: string, user: AuthUser): boolean {
    const session = this.findSessionByDevice(deviceId);
    if (!session) {
      // iOS：管理员直接把控制权抢过来，但不能抢超级管理员
      if (!isAdminRole(user.role)) return false;
      const existing = this.liveIosControl(deviceId);
      if (existing?.role === 'superadmin' && user.role !== 'superadmin') {
        return false;
      }
      this.iosControls.set(deviceId, {
        userId: user.id,
        username: user.username,
        displayName: user.displayName ?? undefined,
        role: user.role,
        since: Date.now(),
        touchedAt: Date.now(),
      });
      void this.recordUsage(deviceId);
      return true;
    }

    // 管理员不能接管超级管理员
    const currentMeta = session.controller
      ? viewerMeta.get(session.controller)
      : undefined;
    if (currentMeta?.user?.role === 'superadmin' && user.role !== 'superadmin') {
      return false;
    }

    // 有人正在控制，或原控制者刚离开还没释放，只有管理员能抢
    if (session.controller && !isAdminRole(user.role)) return false;
    if (!session.controller && session.controllerUserId && !isAdminRole(user.role)) {
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
    this.clearControllerRelease(session);
    this.touchActivity(session);

    if (previous) sendJson(previous, { t: 'role', controller: false });
    sendJson(target, { t: 'role', controller: true });
    this.broadcastViewerList(session);

    void this.recordUsage(deviceId);
    return true;
  }

  /** 同一台设备复用同一个会话，只有第一个 viewer 能控制。 */
  findSessionByDevice(deviceId: string): StreamSession | undefined {
    return [...this.sessions.values()].find(
      (session) => session.device.id === deviceId && !session.closed,
    );
  }

  /**
   * 把 iOS 输入转发给设备所在 agent（远程设备）。
   * 设备插在 server 本机时调用方直接执行 WDA，不走这里。
   */
  sendIosInput(deviceId: string, input: IosInput): boolean {
    const session = this.findSessionByDevice(deviceId);
    if (!session?.agentSocket || session.agentSocket.readyState !== 1) {
      return false;
    }
    sendJson(session.agentSocket, { t: 'iosInput', input });
    return true;
  }

  /**
   * 服务端（例如 AI 助手）直接向设备注入控制消息。
   * 这里不做控制权校验，调用方必须先确认当前用户是控制者。
   * 设备没有活动投屏会话时返回 false，由调用方决定是否先 create()。
   */
  sendControl(deviceId: string, message: ViewerToStreamMessage): boolean {
    const session = this.findSessionByDevice(deviceId);
    if (!session || session.closed) return false;

    try {
      if (session.local) {
        for (const payload of session.local.translator.translate(message)) {
          session.local.scrcpy.sendControl(payload);
        }
        return true;
      }
      if (session.agentSocket && session.agentSocket.readyState === 1) {
        session.agentSocket.send(JSON.stringify(message));
        return true;
      }
    } catch (error) {
      this.deps.logger.warn(
        { deviceId, err: String(error) },
        'sendControl failed',
      );
    }
    return false;
  }

  async create(
    deviceId: string,
    quality: string = 'medium',
  ): Promise<{ sessionId: string; reused: boolean }> {
    // 同一台设备复用已有会话：第二个进入的人只会拿到只读权限
    const reuse = this.findSessionByDevice(deviceId);
    if (reuse) return { sessionId: reuse.id, reused: true };

    const device = await this.deps.queries.getDevice(deviceId);
    if (!device) throw new Error('设备不存在');
    // 本机 iOS 设备走 WDA 直连（HTTP MJPEG + 输入接口），不需要投屏会话；
    // 远程 agent 上的 iOS 才通过会话推流。
    if (device.platform !== 'android' && device.agentId === BUILTIN_AGENT_ID) {
      throw new Error('本机 iOS 设备使用 WDA 直连，不需要投屏会话');
    }

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
      controllerReleaseTimer: null,
      allowViewers: true,
      locked: Boolean(device.locked),
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
    return { sessionId, reused: false };
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

  /** 把当前会话的观看者名单（含控制者标记）广播给所有连接。 */
  private broadcastViewerList(session: StreamSession): void {
    if (session.viewers.size === 0) return;
    const viewers = [...session.viewers]
      .map((socket) => {
        const user = viewerMeta.get(socket)?.user;
        if (!user) return null;
        return {
          userId: user.id,
          username: user.username,
          displayName: user.displayName ?? undefined,
          controller: session.controller === socket,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    const payload = { t: 'viewer.list' as const, viewers };
    for (const viewer of session.viewers) {
      if (viewer.readyState === 1) sendJson(viewer, payload);
    }
  }

  /** 控制者异常掉线后保留 30 秒重连窗口，超时仍无人恢复就释放给其他观看者。 */
  private scheduleControllerRelease(
    session: StreamSession,
    user?: AuthUser,
  ): void {
    this.clearControllerRelease(session);
    session.controllerReleaseTimer = setTimeout(() => {
      session.controllerReleaseTimer = null;
      if (session.closed || session.controller || !session.controllerUserId) {
        return;
      }
      session.controllerUserId = null;
      session.controllerLeftAt = Date.now();
      const payload = {
        t: 'control.released' as const,
        username: user?.username ?? '控制者',
        displayName: user?.displayName ?? undefined,
      };
      for (const viewer of session.viewers) {
        if (viewer.readyState === 1) sendJson(viewer, payload);
      }
      this.broadcastViewerList(session);
      this.notifyDevice(session.device.id);
    }, CONTROLLER_RECONNECT_WINDOW_MS);
    session.controllerReleaseTimer.unref?.();
  }

  private clearControllerRelease(session: StreamSession): void {
    if (!session.controllerReleaseTimer) return;
    clearTimeout(session.controllerReleaseTimer);
    session.controllerReleaseTimer = null;
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

    // 管理员锁定后，任何人都不能控制或查看
    if (session.locked) {
      sendJson(socket, { t: 'error', message: '设备已被管理员锁定' });
      socket.close(4004, '设备已被管理员锁定');
      return;
    }

    // AI 任务独占设备，避免任务执行到一半被人接管
    if (this.taskLocks.has(session.device.id)) {
      sendJson(socket, {
        t: 'error',
        message: '设备正在执行 AI 任务，请稍后再试',
      });
      socket.close(4005, 'task running');
      return;
    }

    const previousController = session.controller;
    // 已有人控制时，只有原控制者本人重连才能恢复，其他人保持只读
    const sameUser = Boolean(user && session.controllerUserId === user.id);
    // iOS 的控制权由 ios/control 接口单独管理，会话里只负责推流
    const becomesController =
      session.device.platform !== 'ios' &&
      !previousController &&
      (!session.controllerUserId || sameUser);

    session.viewers.add(socket);
    if (becomesController) {
      // 同一用户刷新页面重连时保留原来的开始时间，计时不能重置
      const resumed = sameUser && session.controllerSince > 0;
      session.controller = socket;
      if (!resumed) session.controllerSince = Date.now();
      session.controllerUserId = user?.id ?? null;
      session.controllerLeftAt = 0;
      this.clearControllerRelease(session);
      this.touchActivity(session);
    }

    viewerMeta.set(socket, { user, ip, lastTouch: 0 });

    // 控制权发生变化时立刻记录使用并推送设备卡片（控制者、使用中）
    if (becomesController) void this.recordUsage(session.device.id);

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
    // iOS 的控制权由 ios/control 管理，这里不回 role，避免覆盖前端状态
    if (session.device.platform !== 'ios') {
      sendJson(socket, {
        t: 'role',
        controller: session.controller === socket,
      });
    }
    sendJson(socket, { t: 'viewers', allow: session.allowViewers });
    this.broadcastViewerList(session);

    socket.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      this.handleViewerMessage(session, socket, raw.toString());
    });

    socket.on('close', () => {
      session.viewers.delete(socket);
      if (session.controller === socket) {
        const leavingUser = viewerMeta.get(socket)?.user;
        session.controller = null;
        session.controllerLeftAt = Date.now();
        // 保留 controllerUserId：只有本人重连能恢复，其他观看者保持只读
        if (session.viewers.size === 0) {
          this.scheduleIdleStop(session);
        }
        this.broadcastViewerList(session);
        this.notifyDevice(session.device.id);
        this.scheduleControllerRelease(session, leavingUser);
        return;
      }
      if (session.viewers.size === 0) this.scheduleIdleStop(session);
      this.broadcastViewerList(session);
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
    this.clearControllerRelease(session);
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
        if (reason) {
        sendJson(viewer, { t: 'error', message: reason });
        viewer.close(4005, reason.slice(0, 40));
      } else {
        viewer.close();
      }
      }
    }
    session.viewers.clear();

    if (session.agentSocket && session.agentSocket.readyState === 1) {
      session.agentSocket.close();
    }

    this.notifyDevice(session.device.id);
    this.deps.logger.info({ sessionId, reason }, 'stream session closed');
  }

  /**
   * 记录一次使用（开始控制），用于设备列表按使用频率排序。
   * 同一设备 60 秒内重复进入（刷新重连）只算一次；计数后广播最新数据。
   */
  private async recordUsage(deviceId: string): Promise<void> {
    const now = Date.now();
    if (now - (this.usageRecordedAt.get(deviceId) ?? 0) >= USAGE_DEDUPE_MS) {
      this.usageRecordedAt.set(deviceId, now);
      try {
        await this.deps.queries.incrementDeviceUsage(deviceId);
      } catch (error) {
        this.deps.logger.warn(
          { err: String(error), deviceId },
          'record device usage failed',
        );
      }
    }
    this.notifyDevice(deviceId);
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
          allowViewers: this.getAllowViewers(deviceId),
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
        platform: session.device.platform,
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
    const message = parseViewerMessage(raw);
    if (!message) return;

    // 只读观看者也可以请求关键帧（解码器重建后恢复画面）
    if (message.t === 'requestIdr') {
      if (session.lastKeyFrame && socket.readyState === 1) {
        socket.send(session.lastKeyFrame);
      }
      return;
    }

    if (session.controller !== socket) return;

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

    // 触摸 / 滚动太频繁，暂时不写设备日志；后期需要时删掉这一行即可恢复
    if (message.t === 'touch' || message.t === 'scroll') return;

    let action = '';
    let detail = '';

    switch (message.t) {
      case 'key':
        action = 'input.key';
        detail = message.key;
        break;
      case 'text':
        action = 'input.text';
        detail = `输入 ${message.text.length} 个字符`;
        break;
      case 'clipboard':
        action = 'input.clipboard';
        detail = `复制 ${message.text.length} 个字符到剪贴板`;
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
      // 控制者关闭查看时，普通观看者不再收到视频帧（管理员不受限制）
      if (!session.allowViewers && viewer !== session.controller) {
        const meta = viewerMeta.get(viewer);
        if (!isAdminRole(meta?.user?.role ?? '')) continue;
      }
      // 解码跟不上时丢弃该帧，避免延迟雪崩
      if (viewer.bufferedAmount > MAX_BUFFERED_BYTES) continue;
      viewer.send(payload);
    }
  }

  private scheduleIdleStop(session: StreamSession): void {
    this.clearIdleTimer(session);
    session.idleTimer = setTimeout(() => {
      this.destroy(session.id, '长时间无人观看，已自动关闭');
    }, VIEWER_IDLE_TIMEOUT_MS);
  }

  /** 控制者有输入就重置无操作计时；配置为 0 表示不自动断开。 */
  private touchActivity(session: StreamSession): void {
    if (session.activityTimer) {
      clearTimeout(session.activityTimer);
      session.activityTimer = null;
    }
    const minutes = this.deps.settings.getIdleTimeoutMinutes();
    if (minutes <= 0) return;
    session.activityTimer = setTimeout(() => {
      if (session.closed) return;
      this.destroy(session.id, '长时间无操作，已自动断开');
    }, minutes * 60_000);
  }

  private clearIdleTimer(session: StreamSession): void {
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
  }
}

