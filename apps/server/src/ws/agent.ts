import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import {
  AGENT_HEARTBEAT_SEC,
  AGENT_TIMEOUT_SEC,
  WS_PATHS,
  parseAgentMessage,
  type AgentRuntimeInfo,
  type AgentToServerMessage,
  type ServerToAgentMessage,
} from '@adh/protocol';
import type { Logger } from '../log.js';
import type { Queries } from '../db/queries.js';
import type { AgentRegistry } from '../registry.js';
import type { CommandBus } from '../command-bus.js';
import type { ThumbnailStore } from '../storage/thumbnails.js';
import type { SettingsService } from '../settings/service.js';
import type { WebHub } from './web-hub.js';

export interface AgentChannelDeps {
  queries: Queries;
  registry: AgentRegistry;
  hub: WebHub;
  thumbnails: ThumbnailStore;
  commands: CommandBus;
  settings: SettingsService;
  serverVersion: string;
  logger: Logger;
}

/** 未完成握手前的存活时间。 */
const HANDSHAKE_TIMEOUT_MS = 60_000;

export function registerAgentChannel(
  app: FastifyInstance,
  deps: AgentChannelDeps,
): void {
  const { queries, registry, hub, logger } = deps;

  app.get(WS_PATHS.agent, { websocket: true }, (socket: WebSocket) => {
    let agentId: string | null = null;
    let lastSeen = Date.now();
    const connectedAt = Date.now();

    const send = (message: ServerToAgentMessage): void => {
      if (socket.readyState === 1) socket.send(JSON.stringify(message));
    };

    const broadcastAgent = async (id: string, online: boolean): Promise<void> => {
      const summary = await queries.getAgentSummary(id);
      if (summary) hub.broadcast({ t: 'agent.updated', agent: { ...summary, online } });
    };

    const heartbeat = setInterval(() => {
      if (!agentId) {
        if (Date.now() - connectedAt > HANDSHAKE_TIMEOUT_MS) {
          socket.close(4003, 'handshake timeout');
        }
        return;
      }
      if (Date.now() - lastSeen > AGENT_TIMEOUT_SEC * 1000) {
        logger.warn({ agentId }, 'agent heartbeat timeout, closing');
        send({ t: 'stop', reason: 'heartbeat timeout' });
        socket.close(4002, 'heartbeat timeout');
        return;
      }
      send({ t: 'ping', ts: Date.now() });
    }, AGENT_HEARTBEAT_SEC * 1000);
    heartbeat.unref?.();

    const handleHello = async (
      token: string,
      runtime: AgentRuntimeInfo,
    ): Promise<void> => {
      // 普通宿主机 Agent 用独立 key；设备直连 App 用平台全局 key，
      // 每台手机按 instanceId 复用/创建自己的 agent 行，避免互相顶掉。
      let row = await queries.findAgentByToken(token);
      if (!row) {
        const portalKey = await deps.settings.getPortalKey();
        if (token !== portalKey) {
          logger.warn({ host: runtime.name }, 'rejected agent: unknown key');
          send({ t: 'stop', reason: 'invalid key' });
          socket.close(4001, 'invalid key');
          return;
        }
        const instanceId = runtime.instanceId?.trim() || runtime.name;
        row = await queries.ensurePortalAgent(instanceId, runtime);
      }

      agentId = row.id;
      await queries.updateAgentRuntime(agentId, runtime);

      // 同一 agent 重复连接（旧进程未停 / 换了目录启动）：只保留最新实例，
      // 通知旧连接停止重连，避免两个实例同时上报设备
      const previous = registry.get(agentId);
      if (previous && previous.socket !== socket) {
        try {
          if (previous.socket.readyState === 1) {
            previous.socket.send(
              JSON.stringify({
                t: 'stop',
                reason: 'replaced by new connection',
              }),
            );
          }
          previous.socket.close(4000, 'replaced');
        } catch {
          /* 已经断开 */
        }
        registry.detach(agentId);
      }
      registry.attach(agentId, socket);

      send({
        t: 'welcome',
        agentId,
        heartbeatSec: AGENT_HEARTBEAT_SEC,
        serverVersion: deps.serverVersion,
        // 直连设备额外下发本行 token，用于流 / 缩略图 / 安装包下载
        token: row.kind === 'portal' ? row.token : undefined,
      });

      void broadcastAgent(agentId, true);
      logger.info(
        { agentId, name: runtime.name, os: runtime.os },
        'agent connected',
      );
    };

    const handleSync = async (
      currentAgentId: string,
      message: Extract<AgentToServerMessage, { t: 'devices.sync' }>,
    ): Promise<void> => {
      for (const udid of message.remove) {
        const removed = await queries.removeDevice(currentAgentId, udid);
        if (removed) {
          deps.thumbnails.remove(removed.id);
          hub.broadcast({ t: 'device.removed', deviceId: removed.id });
        }
      }
      for (const info of message.add) {
        const device = await queries.upsertDevice(currentAgentId, info);
        hub.broadcast({ t: 'device.updated', device });
      }
      for (const change of message.update) {
        const device = await queries.patchDevice(
          currentAgentId,
          change.udid,
          change.patch,
        );
        if (device) hub.broadcast({ t: 'device.updated', device });
      }
    };

    socket.on('message', (raw: Buffer) => {
      lastSeen = Date.now();
      const message = parseAgentMessage(raw.toString());
      if (!message) {
        logger.debug('discarded malformed agent message');
        return;
      }

      if (message.t === 'hello') {
        if (agentId) return;
        void handleHello(message.token, message.agent).catch((error: unknown) => {
          logger.warn({ err: String(error) }, 'agent hello failed');
        });
        return;
      }

      if (!agentId) return;
      registry.touch(agentId);
      void queries
        .touchAgent(agentId)
        .catch((error: unknown) =>
          logger.warn({ err: String(error) }, 'touch agent failed'),
        );

      if (message.t === 'devices.sync') {
        void handleSync(agentId, message).catch((error: unknown) => {
          logger.warn({ err: String(error) }, 'agent sync failed');
        });
        return;
      }
      if (message.t === 'agent.status') {
        const tasks: Promise<unknown>[] = [
          queries.updateAgentTunnel(agentId, message.tunnel),
        ];
        // 节点刚装完 adb / go-ios 时会随状态上报新能力
        if (message.capabilities) {
          tasks.push(
            queries.updateAgentCapabilities(agentId, message.capabilities),
          );
        }
        void Promise.all(tasks)
          .then(() => broadcastAgent(agentId!, true))
          .catch((error: unknown) => {
            logger.warn({ err: String(error) }, 'agent tunnel status failed');
          });
        return;
      }
      if (message.t === 'cmd.result') {
        // 失败时把设备端返回的原因记下来，方便排查「点了没反应」
        if (!message.ok) {
          logger.warn(
            { agentId, id: message.id, error: message.error },
            'agent command failed',
          );
        }
        deps.commands.handleResult(message);
        return;
      }
      // pong 只用于保活
    });

    socket.on('close', () => {
      clearInterval(heartbeat);
      if (!agentId) return;
      // 已被新连接替换：不要清理新实例的设备状态
      if (registry.get(agentId)?.socket !== socket) return;
      registry.detach(agentId);
      void Promise.all([
        queries.markAgentDevicesOffline(agentId),
        // 节点离线后隧道不可能还连着，别让控制台继续显示最后一次快照
        queries.markAgentTunnelStopped(agentId),
      ])
        .then(([offline]) => {
          for (const device of offline) {
            hub.broadcast({ t: 'device.updated', device });
          }
          return broadcastAgent(agentId!, false);
        })
        .catch((error: unknown) => {
          logger.warn({ err: String(error) }, 'agent disconnect cleanup failed');
        });
      logger.info({ agentId }, 'agent disconnected');
    });

    socket.on('error', (error: Error) => {
      logger.warn({ agentId, err: error.message }, 'agent socket error');
    });
  });
}