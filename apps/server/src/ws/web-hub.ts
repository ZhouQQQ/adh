import type { WebSocket } from 'ws';
import type { DeviceControlInfo, WebEvent } from '@adh/protocol';

/** 浏览器事件通道的订阅者集合，负责 fan-out。 */
export class WebHub {
  private readonly clients = new Set<WebSocket>();
  private controlResolver:
    | ((deviceId: string) => DeviceControlInfo | undefined)
    | null = null;

  /** 广播 device.updated 时补齐当前控制者信息。 */
  setControlResolver(
    resolver: ((deviceId: string) => DeviceControlInfo | undefined) | null,
  ): void {
    this.controlResolver = resolver;
  }

  add(socket: WebSocket): void {
    this.clients.add(socket);
  }

  remove(socket: WebSocket): void {
    this.clients.delete(socket);
  }

  broadcast(event: WebEvent): void {
    if (this.clients.size === 0) return;

    let payload = JSON.stringify(event);
    if (event.t === 'device.updated' && this.controlResolver) {
      const control = this.controlResolver(event.device.id);
      payload = JSON.stringify({
        ...event,
        device: {
          ...event.device,
          inUse: Boolean(control) || event.device.inUse,
          control,
        },
      });
    }

    for (const client of this.clients) {
      if (client.readyState === 1) client.send(payload);
    }
  }

  get size(): number {
    return this.clients.size;
  }
}