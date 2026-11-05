<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  FRAME_KIND,
  decodeFrame,
  nalsToAvcc,
  splitNals,
  type StreamReady,
  type StreamViewerInfo,
  type ViewerToStreamMessage,
} from '@adh/protocol';
import {
  WEB_CODECS_TITLE,
  isWebCodecsAvailable,
  webCodecsHints,
  webCodecsReason,
} from '../utils/webcodecs';
import { withBase, wsUrl } from '../base';

const props = defineProps<{
  sessionId: string;
  platform?: 'android' | 'ios';
  deviceId?: string;
  quality?: 'low' | 'medium' | 'high' | 'ultra';
  /** iOS 没有 WebSocket 会话，控制权由父组件从服务端申请后传入。 */
  controlAllowed?: boolean;
  /** 批量控制等场景：去掉画面四周留白，贴满容器。 */
  flush?: boolean;
  /** 实时预览左上角显示网络延迟（低 / 中 / 高）。 */
  showLatency?: boolean;
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
  /** 当前观看者名单（含控制者标记），在有投屏会话时由服务端推送。 */
  'viewer-list': [viewers: StreamViewerInfo[]];
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const pipVideoRef = ref<HTMLVideoElement | null>(null);
const connected = ref(false);
const controller = ref(false);
const starting = ref(true);
const isIos = computed(() => props.platform === 'ios');

/* ---------------------- WebCodecs 可用性 ---------------------- */

/**
 * WebCodecs 只在安全上下文（https / localhost）暴露。
 * 用局域网 IP 走 http 打开时浏览器会直接隐藏 VideoDecoder，
 * 之前没做判断会抛未捕获异常，画面一直卡在「正在连接设备…」。
 */
const codecUnavailable = ref(false);

const codecReason = computed(() => webCodecsReason());
const codecHints = computed(() => webCodecsHints());

/* ------------------------- 实时预览延迟 ------------------------- */

const latencyMs = ref<number | null>(null);
const latencyLevel = computed<'low' | 'medium' | 'high' | null>(() => {
  if (latencyMs.value === null) return null;
  if (latencyMs.value < 80) return 'low';
  if (latencyMs.value < 200) return 'medium';
  return 'high';
});
const latencyLabel = computed(() => {
  if (latencyLevel.value === 'low') return '低';
  if (latencyLevel.value === 'medium') return '中';
  if (latencyLevel.value === 'high') return '高';
  return '';
});

let latencyTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 用 /api/health 测浏览器到 server 的往返延迟。
 * 它反映预览链路的网络段（不含设备端编码），足以区分低 / 中 / 高。
 */
async function measureLatency(): Promise<void> {
  const startedAt = performance.now();
  try {
    const token = localStorage.getItem('adh.token');
    const response = await fetch(withBase('/api/health'), {
      cache: 'no-store',
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    });
    if (response.ok) {
      latencyMs.value = Math.round(performance.now() - startedAt);
    }
  } catch {
    /* 单次失败保留上一次结果，避免角标闪烁 */
  }
}

function startLatencyProbe(): void {
  if (!props.showLatency || latencyTimer) return;
  void measureLatency();
  latencyTimer = setInterval(() => void measureLatency(), 2_000);
}

function stopLatencyProbe(): void {
  if (latencyTimer) {
    clearInterval(latencyTimer);
    latencyTimer = null;
  }
}

/* ------------------------- 渲染帧率 ------------------------- */

const fps = ref(0);
let renderedFrames = 0;
let fpsWindowStart = performance.now();

/** 每绘制一帧调用一次，按 1 秒窗口统计实际渲染帧率（丢帧会直接反映出来）。 */
function markFrameRendered(): void {
  renderedFrames += 1;
  const now = performance.now();
  const elapsed = now - fpsWindowStart;
  if (elapsed >= 1_000) {
    fps.value = Math.round((renderedFrames * 1_000) / elapsed);
    renderedFrames = 0;
    fpsWindowStart = now;
  }
}

// 父组件拿到 iOS 控制权后同步给播放器，只读时不能操作
watch(
  () => props.controlAllowed,
  (value) => {
    if (isIos.value) controller.value = Boolean(value);
  },
);

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
/** Android 多指：pointerId → 归一化坐标。 */
const activePointers = new Map<number, { x: number; y: number }>();
/** iOS 多指：pointerId → 归一化坐标。 */
const iosPointers = new Map<number, { x: number; y: number }>();
/** 鼠标 Ctrl + 拖动时模拟的第二根手指，避免与浏览器 pointerId 冲突。 */
const PINCH_POINTER_ID = -1001;
/** iOS 双指手势的起始 / 当前两指距离（归一化）。 */
let iosPinchStart: number | null = null;
let iosPinchLast = 0;
/** 触控板缩放正在进行的双指手势状态。 */
let pinchActive = false;
let pinchRadius = 0.15;
let pinchTimer: ReturnType<typeof setTimeout> | null = null;
/** iOS 触控板捏合：合并所有 wheel 事件，停手后只发一次 WDA pinch。 */
let iosWheelScale = 1;
let iosWheelTimer: ReturnType<typeof setTimeout> | null = null;
let recorder: MediaRecorder | null = null;
let iosRecordTimer: ReturnType<typeof setInterval> | null = null;
let iosRecordCanvas: HTMLCanvasElement | null = null;
let recordedChunks: Blob[] = [];
let captureTrack: CanvasCaptureMediaStreamTrack | null = null;
let recorderMime = 'video/webm';
let unmounted = false;
/** 最近的触摸点，画在画面上并写进录屏 */
const touchMarks: Array<{ x: number; y: number; at: number }> = [];
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
  // 本地触摸打点：Android 系统 overlay 不一定被录进投屏，前端也叠加一份
  if (message.t === 'touch' && message.phase !== 'moved') {
    touchMarks.push({ x: message.x, y: message.y, at: Date.now() });
    if (touchMarks.length > 24) touchMarks.shift();
  }
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
    else if (message.key === 'back') iosBackGesture();
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

  // 非安全上下文 / 旧浏览器没有 WebCodecs，直接给出提示，不要抛未捕获异常
  if (!isWebCodecsAvailable()) {
    codecUnavailable.value = true;
    starting.value = false;
    connected.value = false;
    stopWatchdog();
    emit('error', codecReason.value);
    return;
  }
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
        // 只有录制时才把触摸点画进画面，平时预览保持干净
        if (recorder) drawTouchMarks(context, canvas.width, canvas.height);
        captureTrack?.requestFrame();
        markFrameRendered();
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

function stopWatchdog(): void {
  if (!watchdog) return;
  clearInterval(watchdog);
  watchdog = null;
}

function handleBinary(data: ArrayBuffer): void {
  const { kind, payload } = decodeFrame(new Uint8Array(data));

  // 远程 iOS：agent 推的是完整 JPEG 帧，直接画到 canvas
  if (kind === FRAME_KIND.jpeg) {
    void drawIosFrame(payload);
    return;
  }

  if (!decoder || decoder.state !== 'configured') return;
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
    // 远程 iOS 用 JPEG 帧，不需要 WebCodecs
    if (ready.codec === 'jpeg' || ready.platform === 'ios') {
      const canvas = canvasRef.value;
      if (canvas && ready.width > 0 && ready.height > 0) {
        canvas.width = ready.width;
        canvas.height = ready.height;
      }
      connected.value = true;
      starting.value = false;
      emit('ready');
      return;
    }
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
  if (message.t === 'viewer.list') {
    const list = Array.isArray(message.viewers)
      ? (message.viewers as StreamViewerInfo[])
      : [];
    emit('viewer-list', list);
    return;
  }
  if (message.t === 'error') {
    emit('error', String(message.message ?? '投屏出错'));
  }
}

function connect(): void {
  resetPointers();
  codecUnavailable.value = false;

  // 切换设备 / 重连时重新统计，避免沿用上一路的帧率
  fps.value = 0;
  renderedFrames = 0;
  fpsWindowStart = performance.now();

  if (isIos.value) {
    // 控制权由服务端分配，只读用户也能看流但不能操作
    controller.value = props.controlAllowed ?? true;
    emit('controller-change', controller.value);

    if (!props.sessionId) {
      // 本机 iOS：server 直接连 WDA，走 HTTP MJPEG
      void startIosStream();
      return;
    }
    // 远程 iOS：agent 推 JPEG 帧，下面按普通会话连 WebSocket
  }

  // 安卓走 H.264 + WebCodecs：不支持就直接提示，不必白白建立一个会话占着设备
  if (!isWebCodecsAvailable()) {
    codecUnavailable.value = true;
    starting.value = false;
    connected.value = false;
    emit('error', codecReason.value);
    return;
  }

  const token = localStorage.getItem('adh.token') ?? '';
  const ws = new WebSocket(wsUrl(`/ws/stream/${props.sessionId}`, token ? { token } : undefined));
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

/** 在画面上叠加触摸指示（600ms 淡出），实时画面与录屏共用。 */
function drawTouchMarks(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  if (touchMarks.length === 0) return;
  const now = Date.now();
  for (let i = touchMarks.length - 1; i >= 0; i -= 1) {
    const mark = touchMarks[i]!;
    const age = (now - mark.at) / 600;
    if (age >= 1) {
      touchMarks.splice(i, 1);
      continue;
    }
    const x = mark.x * width;
    const y = mark.y * height;
    ctx.beginPath();
    ctx.arc(x, y, 10 + age * 20, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(59, 130, 246, ${1 - age})`;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(59, 130, 246, ${1 - age})`;
    ctx.fill();
  }
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
      if (recorder) drawTouchMarks(context, canvas.width, canvas.height);
      captureTrack?.requestFrame();
      markFrameRendered();
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
      withBase(
        `/api/devices/${props.deviceId}/ios/mjpeg?quality=${props.quality ?? 'medium'}`,
      ),
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
  let failed = false;
  try {
    const response = await fetch(
      withBase(
        `/api/devices/${props.deviceId}/ios/screenshot?quality=${props.quality ?? 'medium'}`,
      ),
      { cache: 'no-store', headers: authHeaders() },
    );
    if (!response.ok) throw new Error('screenshot');

    const buffer = new Uint8Array(await response.arrayBuffer());
    await drawIosFrame(buffer);
  } catch {
    failed = true;
    connected.value = false;
  }

  // 失败时退避，避免接口一直报错时每 200ms 刷一次
  iosTimer = setTimeout(
    () => void pollIosFrame(),
    failed ? Math.max(2_000, IOS_POLL_MS * 10) : IOS_POLL_MS,
  );
}

async function iosInput(payload: Record<string, unknown>): Promise<void> {
  if (!props.deviceId) return;
  try {
    const response = await fetch(
      withBase(`/api/devices/${props.deviceId}/ios/input`),
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

function pointerPosition(event: {
  clientX: number;
  clientY: number;
}): { x: number; y: number } {
  const canvas = canvasRef.value;
  if (!canvas) return { x: 0, y: 0 };
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  };
}

/** 重新连接 / 切换设备时清理多点触控状态，避免残留手指一直按着。 */
function resetPointers(): void {
  activePointers.clear();
  iosPointers.clear();
  iosPinchStart = null;
  iosPinchLast = 0;
  iosStart = null;
  pressing = false;
  if (pinchTimer) {
    clearTimeout(pinchTimer);
    pinchTimer = null;
  }
  pinchActive = false;
  pinchRadius = 0.15;
}

/** 两根手指之间的归一化距离，用于 iOS 计算 pinch 比例。 */
function pointerDistance(
  pointers: Map<number, { x: number; y: number }>,
): number {
  const points = [...pointers.values()];
  if (points.length < 2) return 0;
  const [a, b] = points as [
    { x: number; y: number },
    { x: number; y: number },
  ];
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function onPointerDown(event: PointerEvent): void {
  // 只处理左键 / 触摸，右键留给「返回」
  if (event.button !== 0) return;

  if (isIos.value) {
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    const position = pointerPosition(event);
    iosPointers.set(event.pointerId, position);

    // Ctrl + 拖动：第二根手指放在画面中心对称点，触发一次 pinch
    if (event.pointerType === 'mouse' && event.ctrlKey) {
      iosPointers.set(PINCH_POINTER_ID, {
        x: 1 - position.x,
        y: 1 - position.y,
      });
      iosStart = null;
      iosPinchStart = pointerDistance(iosPointers);
      iosPinchLast = iosPinchStart;
      pressing = true;
      return;
    }

    if (iosPointers.size === 1) {
      iosStart = { ...position, at: Date.now() };
      iosPinchStart = null;
      touchMarks.push({ x: position.x, y: position.y, at: Date.now() });
      if (touchMarks.length > 24) touchMarks.shift();
      pressing = true;
      emit('input', {
        t: 'touch',
        phase: 'began',
        x: position.x,
        y: position.y,
        pointerId: 0,
        pressure: 1,
      });
    } else if (iosPointers.size === 2) {
      // 第二根手指按下：进入双指模式，取消单指的 tap / swipe
      iosStart = null;
      iosPinchStart = pointerDistance(iosPointers);
      iosPinchLast = iosPinchStart;
    }
    return;
  }

  if (!controller.value) return;
  (event.target as HTMLElement).setPointerCapture(event.pointerId);
  const { x, y } = pointerPosition(event);
  activePointers.set(event.pointerId, { x, y });
  pressing = true;
  sendLocal({
    t: 'touch',
    phase: 'began',
    x,
    y,
    pointerId: event.pointerId,
    pressure: 1,
  });

  // 鼠标按住 Ctrl：额外生成一根以画面中心对称的手指，两指反向移动即缩放
  if (event.pointerType === 'mouse' && event.ctrlKey) {
    const mirror = { x: 1 - x, y: 1 - y };
    activePointers.set(PINCH_POINTER_ID, mirror);
    sendLocal({
      t: 'touch',
      phase: 'began',
      x: mirror.x,
      y: mirror.y,
      pointerId: PINCH_POINTER_ID,
      pressure: 1,
    });
  }
}

/** 触控板捏合 = Ctrl + wheel：保持一个连续的双指手势，空闲后再抬起。 */
function sendPinchGesture(scale: number): void {
  if (!controller.value) return;

  const centerX = 0.5;
  const centerY = 0.5;
  const maxRadius = 0.32;
  const leftId = 1001;
  const rightId = 1002;

  // 第一次触发：两指按下，之后只更新距离，避免每帧都 down/up 导致抖动
  if (!pinchActive) {
    pinchActive = true;
    pinchRadius = 0.15;
    sendLocal({ t: 'touch', phase: 'began', x: centerX - pinchRadius, y: centerY, pointerId: leftId, pressure: 1 });
    sendLocal({ t: 'touch', phase: 'began', x: centerX + pinchRadius, y: centerY, pointerId: rightId, pressure: 1 });
  }

  pinchRadius = Math.min(
    maxRadius,
    Math.max(0.06, pinchRadius * scale),
  );
  sendLocal({ t: 'touch', phase: 'moved', x: centerX - pinchRadius, y: centerY, pointerId: leftId, pressure: 1 });
  sendLocal({ t: 'touch', phase: 'moved', x: centerX + pinchRadius, y: centerY, pointerId: rightId, pressure: 1 });

  // 触控板停止捏合 150ms 后抬起两指
  if (pinchTimer) clearTimeout(pinchTimer);
  pinchTimer = setTimeout(() => {
    sendLocal({ t: 'touch', phase: 'ended', x: centerX - pinchRadius, y: centerY, pointerId: leftId, pressure: 0 });
    sendLocal({ t: 'touch', phase: 'ended', x: centerX + pinchRadius, y: centerY, pointerId: rightId, pressure: 0 });
    pinchActive = false;
    pinchTimer = null;
  }, 150);
}

/** 鼠标滚轮：触控板捏合 → 缩放，普通滚动 → 滚动；iOS 用短滑动模拟。 */
function onWheel(event: WheelEvent): void {
  if (!controller.value) return;
  const position = pointerPosition(event);

  // 不同浏览器 / 触控板的 deltaMode 不同（像素 / 行 / 页），统一换算成像素
  const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1;
  const dx = event.deltaX * unit;
  const dy = event.deltaY * unit;

  // 触控板双指捏合会被浏览器映射成 Ctrl + wheel
  if (event.ctrlKey) {
    if (dy === 0) return;
    // 直接按本次事件的 deltaY 缩放，不再累计：
    // 累计器跨方向时会残留旧值，导致同一次张开有时算成正、有时算成负
    const divisor = isIos.value ? 120 : 150;
    // iOS 的 WDA pinch 与 Android 双指手势方向相反，按平台取符号
    const scale = Math.min(
      2,
      Math.max(0.5, Math.exp((isIos.value ? dy : -dy) / divisor)),
    );

    if (import.meta.env.DEV) {
      console.info('[adh pinch]', {
        dy,
        scale,
        platform: isIos.value ? 'ios' : 'android',
      });
    }

    if (isIos.value) {
      // WDA 的 pinch 是一次性手势，一次捏合会有几十条 wheel 事件，
      // 全部合并，停手 250ms 后按累计比例只执行一次
      iosWheelScale = Math.min(10, Math.max(0.1, iosWheelScale * scale));
      if (iosWheelTimer) clearTimeout(iosWheelTimer);
      iosWheelTimer = setTimeout(() => {
        const total = Math.min(10, Math.max(0.1, iosWheelScale));
        iosWheelScale = 1;
        iosWheelTimer = null;
        void iosInput({ type: 'pinch', scale: total, duration: 0.4 });
      }, 250);
      return;
    }

    sendPinchGesture(scale);
    return;
  }

  if (isIos.value) {
    if (dy === 0) return;
    const delta = dy > 0 ? -0.18 : 0.18;
    const toY = Math.min(1, Math.max(0, position.y + delta));
    void iosInput({
      type: 'swipe',
      fromX: position.x,
      fromY: position.y,
      toX: position.x,
      toY,
      duration: 0.2,
    });
    return;
  }

  if (dx === 0 && dy === 0) return;
  sendLocal({
    t: 'scroll',
    x: position.x,
    y: position.y,
    dx,
    dy,
  });
}

/** iOS 没有系统返回键，用左边缘右滑模拟返回上一级。 */
function iosBackGesture(): void {
  if (!controller.value) return;
  void iosInput({
    type: 'swipe',
    fromX: 0.004,
    fromY: 0.5,
    toX: 0.45,
    toY: 0.5,
    duration: 0.28,
  });
}

/** 右键 = 系统返回键。 */
function onContextMenu(event: MouseEvent): void {
  event.preventDefault();
  if (isIos.value) {
    iosBackGesture();
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
    if (!iosPointers.has(event.pointerId)) return;
    const { x, y } = pointerPosition(event);
    iosPointers.set(event.pointerId, { x, y });

    // Ctrl 拖动时虚拟手指始终与鼠标位置关于画面中心对称
    if (iosPointers.has(PINCH_POINTER_ID)) {
      iosPointers.set(PINCH_POINTER_ID, { x: 1 - x, y: 1 - y });
    }
    if (iosPinchStart !== null) {
      iosPinchLast = pointerDistance(iosPointers);
      return;
    }
    if (!iosStart) return;
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

  if (!controller.value) return;
  if (!activePointers.has(event.pointerId)) return;
  const { x, y } = pointerPosition(event);
  activePointers.set(event.pointerId, { x, y });
  sendLocal({
    t: 'touch',
    phase: 'moved',
    x,
    y,
    pointerId: event.pointerId,
    pressure: 1,
  });

  // Ctrl 缩放：虚拟手指同步镜像移动，两指距离变化驱动缩放
  if (activePointers.has(PINCH_POINTER_ID)) {
    const mirror = { x: 1 - x, y: 1 - y };
    activePointers.set(PINCH_POINTER_ID, mirror);
    sendLocal({
      t: 'touch',
      phase: 'moved',
      x: mirror.x,
      y: mirror.y,
      pointerId: PINCH_POINTER_ID,
      pressure: 1,
    });
  }
}

function onPointerUp(event: PointerEvent): void {
  if (isIos.value) {
    if (!iosPointers.has(event.pointerId)) return;
    const position = pointerPosition(event);
    iosPointers.delete(event.pointerId);
    try {
      (event.target as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }

    if (iosPointers.has(PINCH_POINTER_ID)) {
      iosPointers.delete(PINCH_POINTER_ID);
    }

    // 双指手势：WDA 只能执行一次性 pinch，松开时按距离比例触发
    if (iosPinchStart !== null && iosPointers.size < 2) {
      const start = iosPinchStart;
      iosPinchStart = null;
      pressing = false;
      const distance = iosPinchLast || pointerDistance(iosPointers);
      const scale = start > 0 ? distance / start : 1;
      if (scale >= 1.15 || scale <= 0.87) {
        void iosInput({
          type: 'pinch',
          scale: Math.min(10, Math.max(0.1, scale)),
          duration: 0.4,
        });
      }
      return;
    }

    const start = iosStart;
    if (!start) return;
    pressing = false;
    iosStart = null;

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

  if (!activePointers.has(event.pointerId)) return;
  const { x, y } = pointerPosition(event);
  sendLocal({
    t: 'touch',
    phase: 'ended',
    x,
    y,
    pointerId: event.pointerId,
    pressure: 0,
  });
  activePointers.delete(event.pointerId);

  // 抬起鼠标时一并结束虚拟手指
  if (activePointers.has(PINCH_POINTER_ID)) {
    const mirror = activePointers.get(PINCH_POINTER_ID)!;
    sendLocal({
      t: 'touch',
      phase: 'ended',
      x: mirror.x,
      y: mirror.y,
      pointerId: PINCH_POINTER_ID,
      pressure: 0,
    });
    activePointers.delete(PINCH_POINTER_ID);
  }

  pressing = activePointers.size > 0;
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
    if (!controller.value) return;
    if (key === 'back') iosBackGesture();
    else if (key === 'home') void iosInput({ type: 'button', name: 'home' });
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
      withBase(`/api/devices/${props.deviceId}/ios/screenshot?quality=ultra`),
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
        const ctx = target.getContext('2d');
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0);
          drawTouchMarks(ctx, target.width, target.height);
        }
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
  startLatencyProbe();
  connect();
});

onBeforeUnmount(() => {
  unmounted = true;
  stopLatencyProbe();
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
  stopWatchdog();

  if (iosTimer) {
    clearTimeout(iosTimer);
    iosTimer = null;
  }
  iosAbort?.abort();
  iosAbort = null;
});

/** 主动断开：停止 iOS 拉流 / 轮询，或关闭 Android 的 WebSocket。 */
function stopStream(): void {
  resetPointers();
  iosAbort?.abort();
  iosAbort = null;
  if (iosTimer) {
    clearTimeout(iosTimer);
    iosTimer = null;
  }
  if (socket) {
    socket.close();
    socket = null;
  }
  connected.value = false;
}

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
  stopStream,
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
      @wheel.prevent="onWheel"
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
    <div v-if="codecUnavailable" class="overlay codec-overlay">
      <div class="codec-title">{{ WEB_CODECS_TITLE }}</div>
      <div class="codec-desc">{{ codecReason }}</div>
      <ul class="codec-hints">
        <li v-for="hint in codecHints" :key="hint">{{ hint }}</li>
      </ul>
    </div>
    <div v-else-if="starting" class="overlay">正在连接设备…</div>
    <div v-else-if="!connected" class="overlay">连接已断开</div>
    <div v-if="showLatency" class="hud">
      <div
        v-if="latencyLevel"
        class="latency"
        :class="latencyLevel"
        :title="`浏览器到服务器往返 ${latencyMs}ms`"
      >
        <span class="latency-dot" />
        <span class="latency-label">延迟 {{ latencyLabel }}</span>
        <span class="latency-value">{{ latencyMs }}ms</span>
      </div>
      <div v-if="connected" class="latency fps" title="实际渲染帧率">
        <span class="latency-dot" />
        <span class="latency-label">FPS</span>
        <span class="latency-value">{{ fps }}</span>
      </div>
    </div>
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

/* WebCodecs 不可用（http 局域网 IP / 旧浏览器）时的说明层 */
.codec-overlay {
  grid-auto-rows: min-content;
  align-content: center;
  justify-items: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  pointer-events: auto;
  background: rgba(9, 9, 11, 0.86);
}

.codec-title {
  font-size: 14px;
  font-weight: 600;
  color: #fafafa;
}

.codec-desc {
  max-width: 520px;
  font-size: 12px;
  line-height: 1.6;
  color: #d4d4d8;
}

.codec-hints {
  max-width: 520px;
  margin: 4px 0 0;
  padding-left: 18px;
  text-align: left;
  font-size: 12px;
  line-height: 1.7;
  color: #a1a1aa;
}

.hud {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  max-width: calc(100% - 24px);
  pointer-events: none;
}

.latency {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 9px;
  border-radius: 999px;
  background: rgba(15, 18, 24, 0.62);
  backdrop-filter: blur(6px);
  color: #fff;
  font-size: 11px;
  line-height: 1;
  pointer-events: none;
  user-select: none;
}

.latency-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #94a3b8;
}

.latency.low .latency-dot {
  background: #22c55e;
}

.latency.medium .latency-dot {
  background: #f59e0b;
}

.latency.high .latency-dot {
  background: #ef4444;
}

.latency.fps .latency-dot {
  background: #38bdf8;
}

.latency-value {
  opacity: 0.72;
  font-variant-numeric: tabular-nums;
}
</style>