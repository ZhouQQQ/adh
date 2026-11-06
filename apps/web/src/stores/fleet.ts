import { ref, type Ref } from 'vue';
import type { AgentSummary, DeviceSummary, WebEvent } from '@adh/protocol';
import { api } from '../api';
import { wsUrl } from '../base';

export type ConnectionState = 'connecting' | 'online' | 'offline';

const agents = ref<AgentSummary[]>([]);
const devices = ref<DeviceSummary[]>([]);
const connection = ref<ConnectionState>('connecting');
/** 首次快照是否已经取回（区分「还没加载」和「真的没有设备」）。 */
const loaded = ref(false);

let socket: WebSocket | null = null;
let retryTimer: number | undefined;
let syncTimer: number | undefined;
let started = false;
let closed = false;

/** 兜底轮询间隔：WebSocket 偶尔丢事件时用它校正，正常情况不会触发变化。 */
const SYNC_INTERVAL = 30_000;

function upsert<T>(list: T[], item: T, keyOf: (value: T) => string): T[] {
  const index = list.findIndex((entry) => keyOf(entry) === keyOf(item));
  if (index === -1) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

function applyEvent(event: WebEvent): void {
  switch (event.t) {
    case 'agent.updated':
      agents.value = upsert(agents.value, event.agent, (agent) => agent.id);
      break;
    case 'agent.removed':
      agents.value = agents.value.filter((agent) => agent.id !== event.agentId);
      devices.value = devices.value.filter(
        (device) => device.agentId !== event.agentId,
      );
      break;
    case 'device.updated':
      devices.value = upsert(devices.value, event.device, (device) => device.id);
      break;
    case 'device.removed':
      devices.value = devices.value.filter(
        (device) => device.id !== event.deviceId,
      );
      break;
  }
}

function connect(): void {
  if (closed) return;
  const token = localStorage.getItem('adh.token') ?? '';
  const ws = new WebSocket(
    wsUrl('/ws/web', token ? { token } : undefined),
  );
  socket = ws;
  connection.value = 'connecting';

  ws.addEventListener('open', () => {
    connection.value = 'online';
    // server 可能重启过，用快照校正一次
    void refresh();
  });
  ws.addEventListener('message', (event: MessageEvent<string>) => {
    try {
      applyEvent(JSON.parse(event.data) as WebEvent);
    } catch {
      /* 忽略非法帧 */
    }
  });
  ws.addEventListener('close', (event: CloseEvent) => {
    connection.value = 'offline';
    // 单点登录：账号在别处登录后不再自动重连，直接回登录页
    if (event.reason && event.reason.includes('其他位置登录')) {
      closed = true;
      if (syncTimer !== undefined) {
        window.clearInterval(syncTimer);
        syncTimer = undefined;
      }
      localStorage.setItem('adh.kicked', '1');
      window.dispatchEvent(new Event('adh:unauthorized'));
      return;
    }
    if (!closed) {
      retryTimer = window.setTimeout(connect, 3_000);
    }
  });
  ws.addEventListener('error', () => ws.close());
}

async function refresh(): Promise<void> {
  try {
    const [agentList, deviceList] = await Promise.all([
      api.listAgents(),
      api.listDevices(),
    ]);
    agents.value = agentList;
    devices.value = deviceList;
  } catch {
    /* 网络抖动时忽略，WebSocket 重连后会补 */
  } finally {
    // 首次无论成功失败都结束骨架屏，避免网络异常时一直转圈
    loaded.value = true;
  }
}

/** 页面重新可见时立刻校正一次，避免后台标签页错过事件。 */
function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') void refresh();
}

/** 全局只启动一次：拉快照 + 订阅增量。 */
export function startFleet(): void {
  if (started) return;
  started = true;
  closed = false;
  void refresh();
  connect();
  if (syncTimer === undefined) {
    syncTimer = window.setInterval(() => void refresh(), SYNC_INTERVAL);
  }
  document.addEventListener('visibilitychange', onVisibilityChange);
}

export function stopFleet(): void {
  closed = true;
  started = false;
  if (retryTimer !== undefined) window.clearTimeout(retryTimer);
  if (syncTimer !== undefined) window.clearInterval(syncTimer);
  retryTimer = undefined;
  syncTimer = undefined;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  socket?.close();
  socket = null;
}

export function useFleet(): {
  agents: Ref<AgentSummary[]>;
  devices: Ref<DeviceSummary[]>;
  connection: Ref<ConnectionState>;
  /** 首次快照是否已取回。 */
  loaded: Ref<boolean>;
  refresh: () => Promise<void>;
} {
  return { agents, devices, connection, loaded, refresh };
}