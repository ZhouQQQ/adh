import WebSocket from 'ws';
import {
  FRAME_KIND,
  encodeFrame,
  parseViewerMessage,
  type StreamReady,
} from '@adh/protocol';
import { ScrcpyControlTranslator, ScrcpySession } from '@adh/device-host';
import type { Logger } from './log.js';

interface StreamEntry {
  socket: WebSocket;
  scrcpy: ScrcpySession | null;
  translator: ScrcpyControlTranslator | null;
}

function buildStreamUrl(
  serverUrl: string,
  sessionId: string,
  token: string,
): string {
  const base = serverUrl
    .replace(/^http:\/\//i, 'ws://')
    .replace(/^https:\/\//i, 'wss://');
  const url = new URL(base);
  url.pathname = `/ws/stream/${sessionId}`;
  url.search = `?role=agent&token=${encodeURIComponent(token)}`;
  return url.toString();
}

/** agent 侧：按 server 指令建立 scrcpy 会话并转发视频流。 */
export class AgentStreamManager {
  private readonly active = new Map<string, StreamEntry>();

  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
    private readonly logger: Logger,
  ) {}

  async start(sessionId: string, udid: string): Promise<void> {
    if (this.active.has(sessionId)) return;

    const socket = new WebSocket(
      buildStreamUrl(this.serverUrl, sessionId, this.token),
    );
    const entry: StreamEntry = { socket, scrcpy: null, translator: null };
    this.active.set(sessionId, entry);

    socket.on('open', () => {
      const scrcpy = new ScrcpySession({
        udid,
        maxSize: 1280,
        maxFps: 30,
        bitrate: 8_000_000,
        logger: this.logger,
      });
      entry.scrcpy = scrcpy;

      void scrcpy
        .start({
          onMeta: (meta) => {
            entry.translator = new ScrcpyControlTranslator(() => ({
              width: meta.width,
              height: meta.height,
            }));
            const ready: StreamReady = {
              t: 'ready',
              sessionId,
              platform: 'android',
              codec: 'h264',
              videoCodec: meta.codec,
              width: meta.width,
              height: meta.height,
              rotation: 0,
              description: Buffer.from(meta.description).toString('base64'),
            };
            if (socket.readyState === 1) socket.send(JSON.stringify(ready));
          },
          onVideo: (data) => {
            if (socket.readyState !== 1) return;
            if (socket.bufferedAmount > 4 * 1024 * 1024) return;
            socket.send(encodeFrame(FRAME_KIND.h264, data));
          },
          onError: (message) => {
            this.logger.warn({ sessionId, udid, message }, 'scrcpy error');
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ t: 'error', message }));
            }
          },
          onClose: () => {
            this.logger.info({ sessionId, udid }, 'scrcpy session closed');
            this.stop(sessionId);
          },
        })
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : '启动 scrcpy 失败';
          this.logger.warn({ sessionId, udid, err: message }, 'scrcpy start failed');
          if (socket.readyState === 1) {
            socket.send(JSON.stringify({ t: 'error', message }));
          }
          this.stop(sessionId);
        });
    });

    socket.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const message = parseViewerMessage(raw.toString());
      if (!message) return;
      if (!entry.scrcpy || !entry.translator) return;
      for (const payload of entry.translator.translate(message)) {
        entry.scrcpy.sendControl(payload);
      }
    });

    socket.on('error', (error: Error) => {
      this.logger.warn({ sessionId, err: error.message }, 'stream socket error');
    });

    socket.on('close', () => {
      if (!this.active.has(sessionId)) return;
      this.stop(sessionId);
    });
  }

  stop(sessionId: string): void {
    const entry = this.active.get(sessionId);
    if (!entry) return;
    this.active.delete(sessionId);

    void entry.scrcpy?.stop();
    if (entry.socket.readyState === 1) {
      entry.socket.close();
    }
  }

  stopAll(): void {
    for (const sessionId of [...this.active.keys()]) this.stop(sessionId);
  }
}