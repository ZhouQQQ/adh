import type { WebSocket } from 'ws';

export interface LiveAgent {
  id: string;
  socket: WebSocket;
  connectedAt: number;
  lastSeen: number;
}

/** 在线 agent 的内存索引。持久化数据仍在数据库里。 */
export class AgentRegistry {
  private readonly live = new Map<string, LiveAgent>();

  attach(id: string, socket: WebSocket): LiveAgent {
    const entry: LiveAgent = {
      id,
      socket,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.live.set(id, entry);
    return entry;
  }

  detach(id: string): void {
    this.live.delete(id);
  }

  get(id: string): LiveAgent | undefined {
    return this.live.get(id);
  }

  isOnline(id: string): boolean {
    return this.live.has(id);
  }

  ids(): string[] {
    return [...this.live.keys()];
  }

  touch(id: string, at = Date.now()): void {
    const entry = this.live.get(id);
    if (entry) entry.lastSeen = at;
  }
}