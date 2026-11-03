<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  FRAME_KIND,
  decodeFrame,
  nalsToAvcc,
  splitNals,
  type StreamReady,
  type ViewerToStreamMessage,
} from '@adh/protocol';

const props = defineProps<{
  sessionId: string;
  platform?: 'android' | 'ios';
  deviceId?: string;
  quality?: 'low' | 'medium' | 'high' | 'ultra';
  /** 批量控制等场景：去掉画面四周留白，贴满容器。 */
  flush?: boolean;
}>();
const emit = defineEmits<{
  'controller-change': [value: boolean];
  error: [message: string];
  ready: [];
  closed: [];
  /** 本地产生的输入（触摸/按键/文本/屏幕），用于批量联动的镜像转发。 */
  input: [message: ViewerToStreamMessage];
  'control-released': [username: string];
  'viewers-allow': [allow: boolean];
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const pipVideoRef = ref<HTMLVideoElement | null>(null);
const connected = ref(false);
const controller = ref(false);
const starting = ref(true);
const isIos = computed(() => props.platform === 'ios');

let socket: WebSocket | null = null;
let decoder: VideoDecoder | null = null;
/** 最近一次 ready，用于解码器重建 */
let lastReady: StreamReady | null = null;
/** 最近一次成功解出画面的时间 */
let lastOutputAt = 0;
let watchdog: ReturnType<typeof setInterval> | null = null;
let timestamp = 0;
/** 新接入的观看者要等第一个关键帧再解码 */
let waitingKey = true;
let pressing = false;
let recorder: MediaRecorder | null = null;
let iosRecordTimer: ReturnType<typeof setInterval> | null = null;
let iosRecordCanvas: HTMLCanvasElement | null = null;
let recordedChunks: Blob[] = [];
let captureTrack: CanvasCaptureMediaStreamTrack | null = null;
let recorderMime = 'video/webm';
let unmounted = false;
let iosTimer: ReturnType<typeof setTimeout> | null = null;
let iosAbort: AbortController | null = null;
let iosStart: { x: number; y: number; at: number } | null = null;

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function send(message: ViewerToStreamMessage): void {
  if (socket?.readyState === 1) socket.send(JSON.stringify(message));
}

/** 本地输入：发给自己并通知外部，供批量联动转发。 */
function sendLocal(message: ViewerToStreamMessage): void {
  send(message);
  emit('input', message);
}

let remoteIosTouch: { x: number; y: number; at: number } | null = null;

/** 接受联动转发的输入，只发送不再次广播，避免循环。 */
function applyInput(message: ViewerToStreamMessage): void {
  if (!isIos.value) {
    send(message);
    return;
  }

  if (message.t === 'touch') {
    if (message.phase === 'began') {
      remoteIosTouch = { x: message.x, y: message.y, at: Date.now() };
    } else if (message.phase === 'ended') {
      const start = remoteIosTouch;
      remoteIosTouch = null;
      if (!start) return;

      const distance = Math.hypot(message.x - start.x, message.y - start.y);
      if (distance < 0.02) {
        void iosInput({ type: 'tap', x: start.x, y: start.y });
      } else {
        void iosInput({
          type: 'swipe',
          fromX: start.x,
          fromY: start.y,
          toX: message.x,
          toY: message.y,
          duration: Math.min(0.35, Math.max(0.12, (Date.now() - start.at) / 1000)),
        });
      }
    }
    return;
  }

  if (message.t === 'key') {
    if (message.key === 'home') void iosInput({ type: 'button', name: 'home' });
    else if (message.key === 'recent') void iosInput({ type: 'appSwitcher' });
    else if (message.key === 'volumeUp') {
      void iosInput({ type: 'button', name: 'volumeUp' });
    } else if (message.key === 'volumeDown') {
      void iosInput({ type: 'button', name: 'volumeDown' });
    }
    return;
  }

  if (message.t === 'text') {
    void iosInput({ type: 'text', text: message.text });
  }
}

function configureDecoder(ready: StreamReady): void {
  const canvas = canvasRef.value;
  if (!canvas) return;

  lastReady = ready;
  lastOutputAt = Date.now();

  canvas.width = ready.width;
  canvas.height = ready.height;
  waitingKey = true;

  decoder?.close();
  decoder = new VideoDecoder({
    output: (frame) => {
      lastOutputAt = Date.now();
      const context = canvas.getContext('2d');
      if (context) {
        context.drawImage(frame, 0, 0, canvas.width, canvas.height);
        captureTrack?.requestFrame();
      }
      frame.close();
    },
    error: (error) => {
      emit('error', error.message);
      // 解码出错时重建解码器并请求关键帧，避免一直花屏 / 绿屏
      if (lastReady) {
        configureDecoder(lastReady);
        send({ t: 'requestIdr' });
      }
    },
  });

  const description = ready.description
    ? base64ToBytes(ready.description)
    : undefined;

  decoder.configure({
    codec: ready.videoCodec ?? 'avc1.42E01E',
    description,
    optimizeForLatency: true,
  });

  startWatchdog();
}

/** 长时间解不出画面时自动重建解码器并请求关键帧。 */
function startWatchdog(): void {
  if (watchdog) return;
  watchdog = setInterval(() => {
    if (!decoder || decoder.state !== 'configured') return;
    if (!lastReady || socket?.readyState !== 1) return;
    if (Date.now() - lastOutputAt < 5_000) return;
    configureDecoder(lastReady);
    send({ t: 'requestIdr' });
    lastOutputAt = Date.now();
  }, 3_000);
}

function handleBinary(data: ArrayBuffer): void {
  if (!decoder || decoder.state !== 'configured') return;
  const { kind, payload } = decodeFrame(new Uint8Array(data));
  if (kind !== FRAME_KIND.h264) return;

  // 参数集走 description，帧内再带 SPS/PPS 容易让解码器颜色错乱（绿屏）
  const nals = splitNals(payload).filter((nal) => {
    const type = (nal[0] ?? 0) & 0x1f;
    return type !== 7 && type !== 8;
  });
  const isKey = nals.some((nal) => ((nal[0] ?? 0) & 0x1f) === 5);

  // 中途加入的观看者会先收到 P 帧，必须等第一个关键帧再解码，否则黑屏
  if (waitingKey) {
    if (!isKey) return;
    waitingKey = false;
  }

  try {
    decoder.decode(
      new EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        timestamp,
        data: nalsToAvcc(nals),
      }),
    );
    timestamp += 33_333;
  } catch {
    /* 解码器配置切换期间可能拒绝个别帧 */
  }
}

function handleText(raw: string): void {
  let message: { t?: string } & Record<string, unknown>;
  try {
    message = JSON.parse(raw) as { t?: string } & Record<string, unknown>;
  } catch {
    return;
  }

  if (message.t === 'ready') {
    const ready = message as unknown as StreamReady;
    configureDecoder(ready);
    starting.value = false;
    emit('ready');
    return;
  }
  if (message.t === 'role') {
    controller.value = Boolean(message.controller);
    emit('controller-change', controller.value);
    return;
  }
  if (message.t === 'control.released') {
    controller.value = false;
    emit('controller-change', false);
    emit('control-released', String(message.username ?? ''));
    return;
  }
  if (message.t === 'viewers') {
    emit('viewers-allow', Boolean(message.allow));
    return;
  }
  if (message.t === 'error') {
    emit('error', String(message.message ?? '投屏出错'));
  }
}

function connect(): void {
  if (isIos.value) {
    controller.value = true;
    emit('controller-change', true);
    void startIosStream();
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const token = localStorage.getItem('adh.token') ?? '';
  const ws = new WebSocket(
    `${protocol}://${window.location.host}/ws/stream/${props.sessionId}?token=${encodeURIComponent(token)}`,
  );
  ws.binaryType = 'arraybuffer';
  socket = ws;

  ws.addEventListener('open', () => {
    connected.value = true;
  });
  ws.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => {
    if (typeof event.data === 'string') handleText(event.data);
    else handleBinary(event.data);
  });
  ws.addEventListener('close', (event: CloseEvent) => {
    connected.value = false;
    if (event.reason) emit('error', event.reason);
    if (event.reason && event.reason.includes('其他位置登录')) {
      localStorage.setItem('adh.kicked', '1');
      window.dispatchEvent(new Event('adh:unauthorized'));
      return;
    }
    if (!unmounted) emit('closed');
  });
  ws.addEventListener('error', () => ws.close());
}

const IOS_POLL_MS = 200;

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(a.length + b.length);
  output.set(a, 0);
  output.set(b, a.length);
  return output;
}

function indexOfMarker(
  buffer: Uint8Array,
  first: number,
  second: number,
  from = 0,
): number {
  for (let i = from; i < buffer.length - 1; i += 1) {
    if (buffer[i] === first && buffer[i + 1] === second) return i;
  }
  return -1;
}

async function drawIosFrame(data: Uint8Array): Promise<void> {
  const bitmap = await createImageBitmap(
    new Blob([data as unknown as BlobPart], { type: 'image/jpeg' }),
  );
  const canvas = canvasRef.value;
  if (canvas) {
    if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
    if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (context) {
      context.drawImage(bitmap, 0, 0);
      captureTrack?.requestFrame();
    }
  }
  bitmap.close();
  starting.value = false;
  connected.value = true;
}

/** 优先消费 WDA 的 MJPEG 流（约 10fps），失败再退回截图轮询。 */
function authHeaders(
  extra?: Record<string, string>,
): Record<string, string> {
  const token = localStorage.getItem('adh.token');
  return {
    ...(extra ?? {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function startIosStream(): Promise<void> {
  iosAbort?.abort();
  const controller = new AbortController();
  iosAbort = controller;

  try {
    const response = await fetch(
      `/api/devices/${props.deviceId}/ios/mjpeg?quality=${props.quality ?? 'medium'}`,
      { signal: controller.signal, cache: 'no-store', headers: authHeaders() },
    );
    if (!response.ok || !response.body) throw new Error('mjpeg unavailable');

    const reader = response.body.getReader();
    let buffer = new Uint8Array(0);

    while (!unmounted && !controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) buffer = concatBytes(buffer, value);

      let latest: Uint8Array | null = null;
      while (true) {
        const start = indexOfMarker(buffer, 0xff, 0xd8);
        const end = start >= 0 ? indexOfMarker(buffer, 0xff, 0xd9, start + 2) : -1;
        if (start < 0 || end < 0) break;

        // 只画最新一帧：渲染慢时丢掉积压的旧帧，避免延迟越积越大
        latest = buffer.slice(start, end + 2);
        buffer = buffer.slice(end + 2);
      }
      if (latest) await drawIosFrame(latest);

      if (buffer.length > 4_000_000) buffer = buffer.slice(buffer.length - 2);
    }
  } catch {
    /* 流不可用时退回轮询 */
  }

  if (!unmounted && !controller.signal.aborted) {
    void pollIosFrame();
  }
}

async function pollIosFrame(): Promise<void> {
  if (unmounted || !isIos.value) return;
  try {
    const response = await fetch(
      `/api/devices/${props.deviceId}/ios/screenshot?quality=${props.quality ?? 'medium'}`,
      { cache: 'no-store', headers: authHeaders() },
    );
    if (!response.ok) throw new Error('screenshot');

    const buffer = new Uint8Array(await response.arrayBuffer());
    await drawIosFrame(buffer);
  } catch {
    connected.value = false;
  }

  iosTimer = setTimeout(() => void pollIosFrame(), IOS_POLL_MS);
}

async function iosInput(payload: Record<string, unknown>): Promise<void> {
  if (!props.deviceId) return;
  try {
    const response = await fetch(
      `/api/devices/${props.deviceId}/ios/input`,
      {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      emit('error', body?.error ?? 'iOS 操作失败');
    }
  } catch (error) {
    emit('error', error instanceof Error ? error.message : 'iOS 操作失败');
  }
}

function pointerPosition(event: PointerEvent): { x: number; y: number } {
  const canvas = canvasRef.value;
  if (!canvas) return { x: 0, y: 0 };
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  };
}

function onPointerDown(event: PointerEvent): void {
  // 只处理左键 / 触摸，右键留给「返回」
  if (event.button !== 0) return;

  if (isIos.value) {
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    const position = pointerPosition(event);
    iosStart = { ...position, at: Date.now() };
    pressing = true;
    emit('input', {
      t: 'touch',
      phase: 'began',
      x: position.x,
      y: position.y,
      pointerId: 0,
      pressure: 1,
    });
    return;
  }

  if (!controller.value) return;
  (event.target as HTMLElement).setPointerCapture(event.pointerId);
  pressing = true;
  const { x, y } = pointerPosition(event);
  sendLocal({ t: 'touch', phase: 'began', x, y, pointerId: 0, pressure: 1 });
}

/** 右键 = 系统返回键。 */
function onContextMenu(event: MouseEvent): void {
  event.preventDefault();
  if (isIos.value) {
    void iosInput({ type: 'button', name: 'home' });
    return;
  }
  if (!controller.value) return;
  sendLocal({ t: 'key', key: 'back' });
}

/** 中键 = Home 键。 */
function onAuxClick(event: MouseEvent): void {
  if (event.button !== 1) return;
  event.preventDefault();
  if (isIos.value) {
    void iosInput({ type: 'button', name: 'home' });
    return;
  }
  if (!controller.value) return;
  sendLocal({ t: 'key', key: 'home' });
}

function onPointerMove(event: PointerEvent): void {
  if (isIos.value) {
    if (!iosStart) return;
    const { x, y } = pointerPosition(event);
    emit('input', {
      t: 'touch',
      phase: 'moved',
      x,
      y,
      pointerId: 0,
      pressure: 1,
    });
    return;
  }
  if (!pressing || !controller.value) return;
  const { x, y } = pointerPosition(event);
  sendLocal({ t: 'touch', phase: 'moved', x, y, pointerId: 0, pressure: 1 });
}

function onPointerUp(event: PointerEvent): void {
  if (isIos.value) {
    if (!iosStart) return;
    pressing = false;
    const start = iosStart;
    iosStart = null;
    const position = pointerPosition(event);
    try {
      (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }

    const distance = Math.hypot(position.x - start.x, position.y - start.y);
    emit('input', {
      t: 'touch',
      phase: 'ended',
      x: position.x,
      y: position.y,
      pointerId: 0,
      pressure: 0,
    });
    if (distance < 0.02) {
      void iosInput({ type: 'tap', x: start.x, y: start.y });
    } else {
      void iosInput({
        type: 'swipe',
        fromX: start.x,
        fromY: start.y,
        toX: position.x,
        toY: position.y,
        duration: Math.min(0.35, Math.max(0.12, (Date.now() - start.at) / 1000)),
      });
    }
    return;
  }

  if (!pressing) return;
  pressing = false;
  const { x, y } = pointerPosition(event);
  sendLocal({ t: 'touch', phase: 'ended', x, y, pointerId: 0, pressure: 0 });
  try {
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);
  } catch {
    /* ignore */
  }
}

function sendKey(
  key:
    | 'home'
    | 'back'
    | 'recent'
    | 'power'
    | 'volumeUp'
    | 'volumeDown'
    | 'mute',
): void {
  if (isIos.value) {
    if (key === 'home') void iosInput({ type: 'button', name: 'home' });
    else if (key === 'recent') void iosInput({ type: 'appSwitcher' });
    else if (key === 'power') void iosInput({ type: 'screenToggle' });
    else if (key === 'mute') void iosInput({ type: 'mute' });
    else if (key === 'volumeUp') void iosInput({ type: 'button', name: 'volumeUp' });
    else if (key === 'volumeDown') void iosInput({ type: 'button', name: 'volumeDown' });
    return;
  }
  if (!controller.value) return;
  sendLocal({ t: 'key', key });
}

function sendText(text: string): void {
  if (!text) return;
  if (isIos.value) {
    void iosInput({ type: 'text', text });
    return;
  }
  if (!controller.value) return;
  sendLocal({ t: 'text', text });
}

/** 只把文本写进设备剪贴板，不自动粘贴。 */
function sendClipboard(text: string): void {
  if (!text) return;
  if (isIos.value) return;
  if (!controller.value) return;
  sendLocal({ t: 'clipboard', text });
}

function sendRotate(): void {
  if (isIos.value) return;
  if (!controller.value) return;
  sendLocal({ t: 'rotate' });
}

/** 拉下通知栏。 */
function expandNotification(): void {
  if (!controller.value) return;
  sendLocal({ t: 'panel', panel: 'notification' });
}

/** 关闭 / 点亮屏幕（不锁屏）。 */
function setScreen(on: boolean): void {
  // 只有 Android 支持「仅关闭屏幕背光」：scrcpy 关屏后设备仍在运行，
  // web 仍可继续投屏和控制。iOS 没有该能力（lock 会锁屏），因此界面禁用。
  if (isIos.value) return;
  if (!controller.value) return;
  sendLocal({ t: 'screen', on });
}

/** 把当前画面导出成 PNG。 */
function screenshot(): Promise<Blob | null> {
  if (isIos.value) return iosScreenshotPng();
  return new Promise((resolve) => {
    const canvas = canvasRef.value;
    if (!canvas || canvas.width === 0) {
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}

/** iOS 没有 canvas，直接向 WDA 要一帧并转成 PNG。 */
async function iosScreenshotPng(): Promise<Blob | null> {
  const jpeg = await fetchIosFrame();
  if (!jpeg) return null;
  try {
    const bitmap = await createImageBitmap(jpeg);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    bitmap.close();
    return await new Promise((resolve) =>
      canvas.toBlob((blob) => resolve(blob), 'image/png'),
    );
  } catch {
    return null;
  }
}

/** 拉取一帧 iOS 截图（JPEG）。 */
async function fetchIosFrame(): Promise<Blob | null> {
  try {
    const response = await fetch(
      `/api/devices/${props.deviceId}/ios/screenshot?quality=ultra`,
      { cache: 'no-store', headers: authHeaders() },
    );
    if (!response.ok) return null;
    return await response.blob();
  } catch {
    return null;
  }
}

function startRecording(): boolean {
  if (isIos.value) return startIosRecording();
  const canvas = canvasRef.value;
  if (!canvas || recorder || canvas.width === 0) return false;
  try {
    // captureStream(0) + requestFrame：每画一帧才编码，避免录到黑屏
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    captureTrack =
      track && 'requestFrame' in track
        ? (track as CanvasCaptureMediaStreamTrack)
        : null;

    const candidates = [
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4',
      'video/webm;codecs=vp8',
      'video/webm;codecs=vp9',
      'video/webm',
    ];
    recorderMime =
      candidates.find((item) => MediaRecorder.isTypeSupported(item)) ??
      'video/webm';

    recorder = new MediaRecorder(stream, {
      mimeType: recorderMime,
      videoBitsPerSecond: 4_000_000,
    });
    recordedChunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) recordedChunks.push(event.data);
    };
    recorder.start(1000);
    captureTrack?.requestFrame();
    return true;
  } catch {
    recorder = null;
    captureTrack = null;
    return false;
  }
}

/** iOS 录屏：定时拉截图绘制到离屏 canvas 再录制，约 5fps。 */
function startIosRecording(): boolean {
  if (recorder) return false;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 540;
    canvas.height = 1170;
    iosRecordCanvas = canvas;

    const stream = canvas.captureStream(5);
    const candidates = [
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    recorderMime =
      candidates.find((item) => MediaRecorder.isTypeSupported(item)) ??
      'video/webm';

    recorder = new MediaRecorder(stream, {
      mimeType: recorderMime,
      videoBitsPerSecond: 3_000_000,
    });
    recordedChunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) recordedChunks.push(event.data);
    };
    recorder.start(1000);

    const draw = async (): Promise<void> => {
      const blob = await fetchIosFrame();
      const target = iosRecordCanvas;
      if (!blob || !target) return;
      try {
        const bitmap = await createImageBitmap(blob);
        if (target.width !== bitmap.width) target.width = bitmap.width;
        if (target.height !== bitmap.height) target.height = bitmap.height;
        target.getContext('2d')?.drawImage(bitmap, 0, 0);
        bitmap.close();
      } catch {
        /* 单帧失败跳过 */
      }
    };
    void draw();
    iosRecordTimer = setInterval(() => void draw(), 200);
    return true;
  } catch {
    recorder = null;
    iosRecordCanvas = null;
    return false;
  }
}

function stopRecording(): Promise<Blob | null> {
  if (iosRecordTimer) {
    clearInterval(iosRecordTimer);
    iosRecordTimer = null;
  }
  iosRecordCanvas = null;

  const current = recorder;
  if (!current) return Promise.resolve(null);
  return new Promise((resolve) => {
    current.onstop = () => {
      const blob = new Blob(recordedChunks, { type: recorderMime });
      recordedChunks = [];
      recorder = null;
      captureTrack = null;
      resolve(blob);
    };
    current.stop();
  });
}

/** 录屏文件扩展名要跟实际编码格式一致。 */
function recordingExtension(): string {
  return recorderMime.startsWith('video/mp4') ? 'mp4' : 'webm';
}

/** 小窗用：把当前 canvas 输出成 MediaStream，避免二次开流导致黑屏/抢控制权。 */
function createMirrorStream(): MediaStream | null {
  const canvas = canvasRef.value;
  if (!canvas || canvas.width === 0) return null;
  return canvas.captureStream(30);
}

function mirrorTap(x: number, y: number): void {
  if (isIos.value) {
    void iosInput({ type: 'tap', x, y });
    return;
  }
  send({ t: 'touch', phase: 'began', x, y, pointerId: 0, pressure: 1 });
  send({ t: 'touch', phase: 'ended', x, y, pointerId: 0, pressure: 0 });
}

function mirrorSwipe(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  duration = 0.25,
): void {
  if (isIos.value) {
    void iosInput({
      type: 'swipe',
      fromX,
      fromY,
      toX,
      toY,
      duration: Math.min(0.35, Math.max(0.12, duration)),
    });
    return;
  }
  send({ t: 'touch', phase: 'began', x: fromX, y: fromY, pointerId: 0, pressure: 1 });
  send({
    t: 'touch',
    phase: 'moved',
    x: (fromX + toX) / 2,
    y: (fromY + toY) / 2,
    pointerId: 0,
    pressure: 1,
  });
  send({ t: 'touch', phase: 'ended', x: toX, y: toY, pointerId: 0, pressure: 0 });
}

/** 画中画：把画布内容转成 MediaStream 交给 video 元素，兼容内网 http。 */
async function togglePip(): Promise<'opened' | 'closed' | 'failed'> {
  const canvas = canvasRef.value;
  const video = pipVideoRef.value;
  if (!canvas || !video) return 'failed';

  if (document.pictureInPictureElement) {
    await document.exitPictureInPicture();
    return 'closed';
  }

  try {
    const stream = canvas.captureStream(30);
    video.srcObject = stream;
    await video.play();
    await video.requestPictureInPicture();
    return 'opened';
  } catch {
    return 'failed';
  }
}

function releasePipStream(): void {
  const video = pipVideoRef.value;
  if (!video) return;
  const stream = video.srcObject as MediaStream | null;
  stream?.getTracks().forEach((track) => track.stop());
  video.srcObject = null;
}

onMounted(() => {
  pipVideoRef.value?.addEventListener('leavepictureinpicture', releasePipStream);
  connect();
});

onBeforeUnmount(() => {
  unmounted = true;
  releasePipStream();
  socket?.close();
  socket = null;
  if (recorder) {
    try {
      recorder.stop();
    } catch {
      /* ignore */
    }
    recorder = null;
  }
  decoder?.close();
  decoder = null;
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }

  if (iosTimer) {
    clearTimeout(iosTimer);
    iosTimer = null;
  }
  iosAbort?.abort();
  iosAbort = null;
});

defineExpose({
  sendKey,
  sendText,
  sendClipboard,
  sendRotate,
  setScreen,
  expandNotification,
  applyInput,
  screenshot,
  startRecording,
  stopRecording,
  recordingExtension,
  createMirrorStream,
  mirrorTap,
  mirrorSwipe,
  togglePip,
  controller,
  connected,
});
</script>

<template>
  <div class="player" :class="{ flush }">
    <canvas
      ref="canvasRef"
      class="surface"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @contextmenu="onContextMenu"
      @auxclick="onAuxClick"
    />
    <video
      ref="pipVideoRef"
      class="pip-video"
      muted
      playsinline
      autoplay
    />
    <div v-if="starting" class="overlay">正在连接设备…</div>
    <div v-else-if="!connected" class="overlay">连接已断开</div>
  </div>
</template>

<style scoped>
.player {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 12px;
}

.player.flush {
  padding: 0;
}

.player.flush .surface {
  border-radius: 0;
}

.surface {
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  display: block;
  touch-action: none;
  cursor: crosshair;
  outline: none;
  border-radius: 6px;
}

.pip-video {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 12px;
  color: var(--text-dim);
  background: rgba(0, 0, 0, 0.6);
  pointer-events: none;
}
</style>