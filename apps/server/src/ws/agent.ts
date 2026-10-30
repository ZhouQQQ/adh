import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
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
import { rowToAgent } from '../db/queries.js';
import type { AgentRegistry } from '../registry.js';
import type { WebHub } from './web-hub.js';

export interface AgentChannelDeps {
  queries: Queries;
  registry: AgentRegistry;
  hub: WebHub;
  registrationCode: string;
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

    const handleHello = (
      token: string,
      runtime: AgentRuntimeInfo,
    ): void => {
      let row = queries.findAgentByToken(token);
      let issuedToken: string | undefined;

      // 用一次性注册码接入：复用同宿主机记录或新建
      if (!row && token === deps.registrationCode) {
        issuedToken = randomUUID();
        const sameHost = queries.findAgentByName(runtime.name, runtime.os);
        if (sameHost) {
          queries.updateAgentToken(sameHost.id, issuedToken);
          queries.updateAgentRuntime(sameHost.id, runtime);
          row = queries.getAgent(sameHost.id);
        } else {
          row = queries.createAgent({
            name: runtime.name,
            os: runtime.os,
            arch: runtime.arch,
            version: runtime.version,
            capabilities: runtime.capabilities,
            token: issuedToken,
          });
        }
      }

      if (!row) {
        logger.warn({ host: runtime.name }, 'rejected agent: invalid token');
        send({ t: 'stop', reason: 'invalid token' });
        socket.close(4001, 'invalid token');
        return;
      }

      agentId = row.id;
      queries.touchAgent(agentId);
      registry.attach(agentId, socket);

      send({
        t: 'welcome',
        agentId,
        heartbeatSec: AGENT_HEARTBEAT_SEC,
        serverVersion: deps.serverVersion,
        ...(issuedToken ? { token: issuedToken } : {}),
      });

      const fresh = queries.getAgent(agentId);
      if (fresh) {
        hub.broadcast({
          t: 'agent.updated',
          agent: { ...rowToAgent(fresh), online: true },
        });
      }
      logger.info(
        { agentId, name: row.name, os: row.os, registered: Boolean(issuedToken) },
        'agent connected',
      );
    };

    const handleSync = (
      currentAgentId: string,
      message: Extract<AgentToServerMessage, { t: 'devices.sync' }>,
    ): void => {
      for (const udid of message.remove) {
        const removed = queries.removeDevice(currentAgentId, udid);
        if (removed) hub.broadcast({ t: 'device.removed', deviceId: removed.id });
      }
      for (const info of message.add) {
        const device = queries.upsertDevice(currentAgentId, info);
        hub.broadcast({ t: 'device.updated', device });
      }
      for (const change of message.update) {
        const device = queries.patchDevice(currentAgentId, change.udid, change.patch);
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
        handleHello(message.token, message.agent);
        return;
      }

      if (!agentId) return;
      registry.touch(agentId);
      queries.touchAgent(agentId);

      if (message.t === 'devices.sync') {
        handleSync(agentId, message);
        return;
      }
      // pong / cmd.result：M0 只用于保活，M2 起处理指令结果
    });

    socket.on('close', () => {
      clearInterval(heartbeat);
      if (!agentId) return;
      registry.detach(agentId);
      const offline = queries.markAgentDevicesOffline(agentId);
      for (const device of offline) {
        hub.broadcast({ t: 'device.updated', device });
      }
      const row = queries.getAgent(agentId);
      if (row) {
        hub.broadcast({
          t: 'agent.updated',
          agent: { ...rowToAgent(row), online: false },
        });
      }
      logger.info({ agentId }, 'agent disconnected');
    });

    socket.on('error', (error: Error) => {
      logger.warn({ agentId, err: error.message }, 'agent socket error');
    });
  });
}