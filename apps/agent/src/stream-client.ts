import WebSocket from 'ws';
import {
  FRAME_KIND,
  encodeFrame,
  parseViewerMessage,
  type StreamReady,
} from '@adh/protocol';
import {
  ScrcpyControlTranslator,
  ScrcpySession,
  applyIosInput,
  ensureMjpegPort,
  ensureWdaForward,
  openMjpegStream,
  resolveQuality,
  wdaApplyMjpegSettings,
  wdaPortFor,
  wdaWindow,
  type MjpegStreamHandle,
} from '@adh/device-host';
import type { Logger } from './log.js';

interface StreamEntry {
  socket: WebSocket;
  sessionId: string;
  platform: 'android' | 'ios';
  udid: string;
  scrcpy: ScrcpySession | null;
  translator: ScrcpyControlTranslator | null;
  mjpeg: MjpegStreamHandle | null;
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
  const prefix = url.pathname.replace(/\/+$/, '');
  url.pathname = `${prefix}/ws/stream/${sessionId}`;
  url.search = `?role=agent&token=${encodeURIComponent(token)}`;
  return url.toString();
}

/** iOS 画质：直接改 WDA 内置 MJPEG 的帧率 / 质量 / 缩放。 */
function iosMjpegSettings(quality: string): {
  framerate: number;
  quality: number;
  scaling: number;
} {
  if (quality === 'low') return { framerate: 30, quality: 25, scaling: 25 };
  if (quality === 'high') return { framerate: 30, quality: 75, scaling: 100 };
  if (quality === 'ultra') return { framerate: 30, quality: 95, scaling: 100 };
  return { framerate: 24, quality: 45, scaling: 50 };
}

/** agent 侧：按 server 指令建立投屏会话并转发视频流。 */
export class AgentStreamManager {
  private readonly active = new Map<string, StreamEntry>();

  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
    private readonly logger: Logger,
  ) {}

  async start(
    sessionId: string,
    udid: string,
    quality = 'medium',
    platform: 'android' | 'ios' = 'android',
  ): Promise<void> {
    if (this.active.has(sessionId)) return;

    const socket = new WebSocket(
      buildStreamUrl(this.serverUrl, sessionId, this.token),
    );
    const entry: StreamEntry = {
      socket,
      sessionId,
      platform,
      udid,
      scrcpy: null,
      translator: null,
      mjpeg: null,
    };
    this.active.set(sessionId, entry);

    socket.on('open', () => {
      if (platform === 'ios') {
        void this.startIos(entry, quality);
        return;
      }
      this.startAndroid(entry, quality);
    });

    socket.on('message', (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      const message = parseViewerMessage(raw.toString());
      if (!message) return;

      if (entry.platform === 'ios') {
        if (message.t === 'iosInput') {
          const port = wdaPortFor(entry.udid);
          void applyIosInput(port, message.input).catch((error: unknown) => {
            this.logger.warn(
              { sessionId, err: String(error) },
              'ios input failed',
            );
          });
        }
        return;
      }

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

  /** 安卓：scrcpy H.264 推流。 */
  private startAndroid(entry: StreamEntry, quality: string): void {
    const { sessionId, udid, socket } = entry;
    const { preset } = resolveQuality(quality);
    const scrcpy = new ScrcpySession({
      udid,
      maxSize: preset.maxSize,
      maxFps: 30,
      bitrate: preset.bitrate,
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
  }

  /**
   * iOS：把 WDA 的 MJPEG 流转成 JPEG 帧推给 server。
   * 端口转发和 WDA 都在 agent 本机执行，server 不需要 USB。
   */
  private async startIos(entry: StreamEntry, quality: string): Promise<void> {
    const { sessionId, udid, socket } = entry;
    const send = (message: unknown): void => {
      if (socket.readyState === 1) socket.send(JSON.stringify(message));
    };

    try {
      const port = await ensureWdaForward(udid);
      if (!port) throw new Error('WDA 未启动或端口转发失败');

      const mjpegPort = await ensureMjpegPort(udid);
      if (!mjpegPort) throw new Error('MJPEG 端口转发失败');

      await wdaApplyMjpegSettings(port, iosMjpegSettings(quality));

      let width = 0;
      let height = 0;
      try {
        const size = await wdaWindow(port);
        width = size.width;
        height = size.height;
      } catch {
        /* 尺寸拿不到时前端按首帧自适应 */
      }

      send({
        t: 'ready',
        sessionId,
        platform: 'ios',
        codec: 'jpeg',
        width,
        height,
        rotation: 0,
      } satisfies StreamReady);

      entry.mjpeg = await openMjpegStream(
        mjpegPort,
        (frame) => {
          if (socket.readyState !== 1) return;
          if (socket.bufferedAmount > 4 * 1024 * 1024) return;
          socket.send(encodeFrame(FRAME_KIND.jpeg, frame));
        },
        (message) => {
          this.logger.warn({ sessionId, udid, message }, 'ios mjpeg error');
          send({ t: 'error', message });
        },
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '启动 iOS 投屏失败';
      this.logger.warn({ sessionId, udid, err: message }, 'ios stream failed');
      send({ t: 'error', message });
      this.stop(sessionId);
    }
  }

  stop(sessionId: string): void {
    const entry = this.active.get(sessionId);
    if (!entry) return;
    this.active.delete(sessionId);

    entry.mjpeg?.stop();
    void entry.scrcpy?.stop();
    if (entry.socket.readyState === 1) {
      entry.socket.close();
    }
  }

  stopAll(): void {
    for (const sessionId of [...this.active.keys()]) this.stop(sessionId);
  }
}
