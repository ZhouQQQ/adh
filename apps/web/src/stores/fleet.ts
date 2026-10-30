import { ref, type Ref } from 'vue';
import type { AgentSummary, DeviceSummary, WebEvent } from '@adh/protocol';
import { api } from '../api';

export type ConnectionState = 'connecting' | 'online' | 'offline';

const agents = ref<AgentSummary[]>([]);
const devices = ref<DeviceSummary[]>([]);
const connection = ref<ConnectionState>('connecting');

let socket: WebSocket | null = null;
let retryTimer: number | undefined;
let started = false;
let closed = false;

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
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${protocol}://${window.location.host}/ws/web`);
  socket = ws;
  connection.value = 'connecting';

  ws.addEventListener('open', () => {
    connection.value = 'online';
  });
  ws.addEventListener('message', (event: MessageEvent<string>) => {
    try {
      applyEvent(JSON.parse(event.data) as WebEvent);
    } catch {
      /* 忽略非法帧 */
    }
  });
  ws.addEventListener('close', () => {
    connection.value = 'offline';
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
  }
}

/** 全局只启动一次：拉快照 + 订阅增量。 */
export function startFleet(): void {
  if (started) return;
  started = true;
  closed = false;
  void refresh();
  connect();
}

export function stopFleet(): void {
  closed = true;
  started = false;
  if (retryTimer !== undefined) window.clearTimeout(retryTimer);
  socket?.close();
  socket = null;
}

export function useFleet(): {
  agents: Ref<AgentSummary[]>;
  devices: Ref<DeviceSummary[]>;
  connection: Ref<ConnectionState>;
  refresh: () => Promise<void>;
} {
  return { agents, devices, connection, refresh };
}