import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  buildAvcC,
  codecString,
  splitNals,
  type H264Config,
} from '@adh/protocol';
import { runCommand } from './exec.js';

const JAR_PATH = fileURLToPath(
  new URL('../resources/scrcpy-server.jar', import.meta.url),
);
const REMOTE_JAR = '/data/local/tmp/adh-scrcpy-server.jar';
const SCRCPY_VERSION = '2.4';
const SOCKET_NAME = 'scrcpy';

/**
 * tunnel_forward 模式下设备端会先写 1 个 dummy 字节用于探测连接，
 * 之后才是 64 字节设备名 + 12 字节视频头（codec id / width / height）。
 */
const DUMMY_LENGTH = 1;
const DEVICE_NAME_LENGTH = 64;
const VIDEO_HEADER_LENGTH = DUMMY_LENGTH + DEVICE_NAME_LENGTH + 12;

/** 每个音视频 packet 前的元数据：8 字节 pts/flags + 4 字节长度。 */
const PACKET_HEADER_LENGTH = 12;
const FLAG_CONFIG = 1n << 63n;
const FLAG_KEY_FRAME = 1n << 62n;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface ScrcpyMeta {
  deviceName: string;
  width: number;
  height: number;
  codec: string;
  /** avcC description */
  description: Uint8Array;
}

export interface ScrcpyHandlers {
  onMeta: (meta: ScrcpyMeta) => void;
  onVideo: (data: Uint8Array, key: boolean) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

export interface ScrcpySessionOptions {
  udid: string;
  maxSize?: number;
  maxFps?: number;
  bitrate?: number;
  logLevel?: 'error' | 'warn' | 'info';
  logger?: {
    debug: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
  };
}

function connectPort(port: number, timeoutMs = 6_000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('scrcpy socket connect timeout'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * 一路 scrcpy 会话。
 *
 * scrcpy 2.x 在 tunnel_forward 模式下由设备端监听 localabstract:scrcpy，
 * 客户端需要按 video → control 的顺序建立两个连接（音频关闭）。
 */
export class ScrcpySession {
  private server: ChildProcess | null = null;
  /** 会话开始前系统是否已经开启触摸显示，用于退出时恢复。 */
  private showTouchesWasOn = false;
  private videoSocket: net.Socket | null = null;
  private controlSocket: net.Socket | null = null;
  private forwardPort = 0;
  private handlers: ScrcpyHandlers | null = null;
  private metaSent = false;
  private deviceName = '';
  private videoWidth = 0;
  private videoHeight = 0;
  private headerBuffer: Buffer = Buffer.alloc(0);
  private headerDone = false;
  private packetBuffer: Buffer = Buffer.alloc(0);
  private closed = false;
  private stopping = false;

  constructor(private readonly options: ScrcpySessionOptions) {}

  async start(handlers: ScrcpyHandlers): Promise<void> {
    this.handlers = handlers;
    const { udid } = this.options;

    await this.pushServer(udid);

    // 记录原值：会话结束后如果本来没开，就恢复关闭，避免触摸点一直残留
    const current = await runCommand(
      'adb',
      ['-s', udid, 'shell', 'settings', 'get', 'system', 'show_touches'],
      5_000,
    );
    this.showTouchesWasOn = current.stdout.trim() === '1';
    // 直接改系统设置比依赖 scrcpy 参数更可靠
    if (!this.showTouchesWasOn) {
      await runCommand(
        'adb',
        [
          '-s',
          udid,
          'shell',
          'settings',
          'put',
          'system',
          'show_touches',
          '1',
        ],
        5_000,
      );
    }

    this.spawnServer(udid);

    // 给设备端 app_process 一点启动时间
    await sleep(600);

    this.forwardPort = await this.forwardPortFor(udid);
    await this.openSockets();
  }

  sendControl(payload: Buffer): void {
    if (this.controlSocket && !this.controlSocket.destroyed) {
      this.controlSocket.write(payload);
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.closed = true;

    this.videoSocket?.destroy();
    this.controlSocket?.destroy();
    this.videoSocket = null;
    this.controlSocket = null;

    this.server?.kill();
    this.server = null;

    // 恢复触摸显示设置，避免退出后真机一直显示白点
    if (!this.showTouchesWasOn) {
      await runCommand(
        'adb',
        [
          '-s',
          this.options.udid,
          'shell',
          'settings',
          'put',
          'system',
          'show_touches',
          '0',
        ],
        5_000,
      );
    }

    if (this.forwardPort > 0) {
      await runCommand(
        'adb',
        ['-s', this.options.udid, 'forward', '--remove', `tcp:${this.forwardPort}`],
        5_000,
      );
      this.forwardPort = 0;
    }
  }

  private async pushServer(udid: string): Promise<void> {
    const result = await runCommand(
      'adb',
      ['-s', udid, 'push', JAR_PATH, REMOTE_JAR],
      60_000,
    );
    if (result.code !== 0) {
      throw new Error(
        `推送 scrcpy-server 失败: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }

  private spawnServer(udid: string): void {
    const {
      maxSize = 1280,
      maxFps = 30,
      bitrate = 8_000_000,
      logLevel = 'error',
    } = this.options;

    const args = [
      '-s',
      udid,
      'shell',
      `CLASSPATH=${REMOTE_JAR}`,
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      SCRCPY_VERSION,
      `log_level=${logLevel}`,
      'audio=false',
      'control=true',
      'tunnel_forward=true',
      'cleanup=false',
      'stay_awake=true',
      'show_touches=true',
      `max_size=${maxSize}`,
      `max_fps=${maxFps}`,
      `video_bit_rate=${bitrate}`,
    ];

    const child = spawn('adb', args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.server = child;

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.options.logger?.debug({ udid }, `scrcpy: ${text}`);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.options.logger?.warn({ udid }, `scrcpy: ${text}`);
    });
    child.on('exit', (code) => {
      this.options.logger?.debug({ udid, code }, 'scrcpy server exited');
      if (!this.stopping) this.handleClose();
    });
  }

  private async forwardPortFor(udid: string): Promise<number> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await runCommand(
        'adb',
        ['-s', udid, 'forward', 'tcp:0', `localabstract:${SOCKET_NAME}`],
        5_000,
      );
      const port = Number(result.stdout.trim());
      if (result.code === 0 && Number.isInteger(port) && port > 0) return port;
      await sleep(250);
    }
    throw new Error('无法建立 scrcpy 端口转发');
  }

  private async openSockets(): Promise<void> {
    // 顺序很重要：设备端先 accept video，再 accept control
    this.openVideoSocket();
    this.controlSocket = await connectPort(this.forwardPort);
    this.controlSocket.on('error', (error) => {
      this.options.logger?.warn(
        { err: error.message },
        'scrcpy control socket error',
      );
    });
  }

  private openVideoSocket(): void {
    const socket = net.connect({ host: '127.0.0.1', port: this.forwardPort });
    this.videoSocket = socket;

    socket.on('data', (chunk: Buffer) => {
      if (!this.headerDone) {
        this.headerBuffer = Buffer.concat([this.headerBuffer, chunk]);
        if (this.headerBuffer.length < VIDEO_HEADER_LENGTH) return;

        this.parseHeader(this.headerBuffer.subarray(0, VIDEO_HEADER_LENGTH));
        const rest = this.headerBuffer.subarray(VIDEO_HEADER_LENGTH);
        this.headerBuffer = Buffer.alloc(0);
        this.headerDone = true;
        if (rest.length > 0) this.consumePackets(rest);
        return;
      }
      this.consumePackets(chunk);
    });

    socket.on('error', (error) => {
      this.options.logger?.warn({ err: error.message }, 'scrcpy video socket error');
      if (!this.stopping) this.handleClose();
    });

    socket.on('close', () => {
      if (!this.stopping) this.handleClose();
    });
  }

  private parseHeader(header: Buffer): void {
    const nameStart = DUMMY_LENGTH;
    this.deviceName = header
      .subarray(nameStart, nameStart + DEVICE_NAME_LENGTH)
      .toString('utf8')
      .replace(/\0[\s\S]*$/, '')
      .trim();

    const metaStart = nameStart + DEVICE_NAME_LENGTH;
    const codecId = header.readUInt32BE(metaStart);
    this.videoWidth = header.readUInt32BE(metaStart + 4);
    this.videoHeight = header.readUInt32BE(metaStart + 8);

    this.options.logger?.debug(
      {
        deviceName: this.deviceName,
        codec: codecId.toString(16),
        width: this.videoWidth,
        height: this.videoHeight,
      },
      'scrcpy video header',
    );
  }

  /** 按 scrcpy packet 格式切片：12 字节头 + payload。 */
  private consumePackets(chunk: Buffer): void {
    this.packetBuffer =
      this.packetBuffer.length === 0
        ? chunk
        : Buffer.concat([this.packetBuffer, chunk]);

    for (;;) {
      if (this.packetBuffer.length < PACKET_HEADER_LENGTH) return;

      const flags = this.packetBuffer.readBigUInt64BE(0);
      const size = this.packetBuffer.readUInt32BE(8);
      if (this.packetBuffer.length < PACKET_HEADER_LENGTH + size) return;

      const payload = this.packetBuffer.subarray(
        PACKET_HEADER_LENGTH,
        PACKET_HEADER_LENGTH + size,
      );
      this.packetBuffer = this.packetBuffer.subarray(
        PACKET_HEADER_LENGTH + size,
      );

      if ((flags & FLAG_CONFIG) !== 0n) {
        this.handleConfig(payload);
        continue;
      }

      const key = (flags & FLAG_KEY_FRAME) !== 0n;
      this.handlers?.onVideo(payload, key);
    }
  }

  private handleConfig(payload: Buffer): void {
    const nals = splitNals(payload);
    const sps = nals.find((nal) => ((nal[0] ?? 0) & 0x1f) === 7);
    const pps = nals.find((nal) => ((nal[0] ?? 0) & 0x1f) === 8);
    if (!sps || !pps || this.metaSent) return;

    const description = buildAvcC(sps, pps);
    if (!description) return;

    const config: H264Config = {
      sps,
      pps,
      description,
      codec: codecString(sps),
    };

    this.metaSent = true;
    this.handlers?.onMeta({
      deviceName: this.deviceName,
      width: this.videoWidth,
      height: this.videoHeight,
      codec: config.codec,
      description: config.description,
    });
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers?.onClose();
  }
}