import type { WebSocket } from 'ws';
import type { WebEvent } from '@adh/protocol';

/** 浏览器事件通道的订阅者集合，负责 fan-out。 */
export class WebHub {
  private readonly clients = new Set<WebSocket>();

  add(socket: WebSocket): void {
    this.clients.add(socket);
  }

  remove(socket: WebSocket): void {
    this.clients.delete(socket);
  }

  broadcast(event: WebEvent): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === 1) client.send(payload);
    }
  }

  get size(): number {
    return this.clients.size;
  }
}