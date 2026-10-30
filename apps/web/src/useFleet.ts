import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentSummary, DeviceSummary, WebEvent } from '@adh/protocol';

export type ConnectionState = 'connecting' | 'online' | 'offline';

function upsert<T>(list: T[], item: T, keyOf: (value: T) => string): T[] {
  const index = list.findIndex((entry) => keyOf(entry) === keyOf(item));
  if (index === -1) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

/** 拉取初始快照，并通过 /ws/web 接收实时增量。 */
export function useFleet() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const socketRef = useRef<WebSocket | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [agentsResponse, devicesResponse] = await Promise.all([
        fetch('/api/agents'),
        fetch('/api/devices'),
      ]);
      if (agentsResponse.ok) {
        setAgents((await agentsResponse.json()) as AgentSummary[]);
      }
      if (devicesResponse.ok) {
        setDevices((await devicesResponse.json()) as DeviceSummary[]);
      }
    } catch {
      // 网络抖动时忽略，WebSocket 重连后会拿到增量
    }
  }, []);

  const applyEvent = useCallback((event: WebEvent) => {
    switch (event.t) {
      case 'agent.updated':
        setAgents((prev) => upsert(prev, event.agent, (agent) => agent.id));
        break;
      case 'agent.removed':
        setAgents((prev) => prev.filter((agent) => agent.id !== event.agentId));
        break;
      case 'device.updated':
        setDevices((prev) => upsert(prev, event.device, (device) => device.id));
        break;
      case 'device.removed':
        setDevices((prev) => prev.filter((device) => device.id !== event.deviceId));
        break;
    }
  }, []);

  useEffect(() => {
    void refresh();
    let closed = false;
    let retryTimer: number | undefined;

    const connect = (): void => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(
        `${protocol}://${window.location.host}/ws/web`,
      );
      socketRef.current = socket;
      setConnection('connecting');

      socket.onopen = () => setConnection('online');
      socket.onmessage = (event: MessageEvent<string>) => {
        try {
          applyEvent(JSON.parse(event.data) as WebEvent);
        } catch {
          /* 忽略非法帧 */
        }
      };
      socket.onclose = () => {
        setConnection('offline');
        if (!closed) {
          retryTimer = window.setTimeout(connect, 3_000);
        }
      };
      socket.onerror = () => socket.close();
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      socketRef.current?.close();
    };
  }, [applyEvent, refresh]);

  return { agents, devices, connection, refresh };
}