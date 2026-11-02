import { randomUUID } from 'node:crypto';
import type { CmdResultMessage } from '@adh/protocol';
import type { AgentRegistry } from './registry.js';

interface PendingCommand {
  resolve: (result: CmdResultMessage) => void;
  timer: NodeJS.Timeout;
}

/** 给 agent 下发指令并等待 cmd.result，用于同步拿到执行结果。 */
export class CommandBus {
  private readonly pending = new Map<string, PendingCommand>();

  constructor(private readonly registry: AgentRegistry) {}

  send(
    agentId: string,
    action: string,
    params: unknown,
    deviceId?: string,
    timeoutMs = 300_000,
  ): Promise<CmdResultMessage> {
    const live = this.registry.get(agentId);
    if (!live) return Promise.reject(new Error('设备所在节点已离线'));

    const id = randomUUID();
    return new Promise<CmdResultMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('指令执行超时'));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, { resolve, timer });
      live.socket.send(
        JSON.stringify({ t: 'cmd', id, deviceId, action, params }),
      );
    });
  }

  handleResult(message: CmdResultMessage): void {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(message.id);
    entry.resolve(message);
  }

  clear(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
  }
}