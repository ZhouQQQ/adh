import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { WS_PATHS } from '@adh/protocol';
import type { StreamManager } from '../stream/manager.js';

export function registerStreamChannel(
  app: FastifyInstance,
  manager: StreamManager,
): void {
  app.get(
    `${WS_PATHS.stream}/:sessionId`,
    { websocket: true },
    (socket: WebSocket, request) => {
      const { sessionId } = request.params as { sessionId: string };
      const query = request.query as { role?: string; token?: string };

      if (query.role === 'agent') {
        void manager.attachAgent(sessionId, socket, query.token ?? '');
        return;
      }
      manager.attachViewer(sessionId, socket);
    },
  );
}