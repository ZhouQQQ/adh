import type { WebSocket } from 'ws';
import type { AuthUser } from '../auth/service.js';
import type { DeviceControlInfo, WebEvent } from '@adh/protocol';

/** 浏览器事件通道的订阅者集合，负责 fan-out。 */
export class WebHub {
  /** socket 对应的登录用户，用于单点登录时踢掉旧连接。 */
  private readonly clients = new Map<WebSocket, { userId?: string }>();
  private controlResolver:
    | ((deviceId: string) => DeviceControlInfo | undefined)
    | null = null;

  /** 广播 device.updated 时补齐当前控制者信息。 */
  setControlResolver(
    resolver: ((deviceId: string) => DeviceControlInfo | undefined) | null,
  ): void {
    this.controlResolver = resolver;
  }

  add(socket: WebSocket, user?: AuthUser): void {
    this.clients.set(socket, { userId: user?.id });
  }

  remove(socket: WebSocket): void {
    this.clients.delete(socket);
  }

  /** 同一账号在别处登录：关闭该用户的所有浏览器连接。 */
  kickUser(userId: string): void {
    for (const [socket, meta] of this.clients) {
      if (meta.userId !== userId) continue;
      try {
        socket.close(4001, '账号已在其他位置登录');
      } catch {
        /* 连接可能已经关闭 */
      }
      this.clients.delete(socket);
    }
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

    for (const client of this.clients.keys()) {
      if (client.readyState === 1) client.send(payload);
    }
  }

  get size(): number {
    return this.clients.size;
  }
}