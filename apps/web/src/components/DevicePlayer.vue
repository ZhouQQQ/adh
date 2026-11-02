<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import {
  FRAME_KIND,
  annexBToAvcc,
  decodeFrame,
  splitNals,
  type StreamReady,
  type ViewerToStreamMessage,
} from '@adh/protocol';

const props = defineProps<{ sessionId: string }>();
const emit = defineEmits<{
  'controller-change': [value: boolean];
  error: [message: string];
  ready: [];
}>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const connected = ref(false);
const controller = ref(false);
const starting = ref(true);

let socket: WebSocket | null = null;
let decoder: VideoDecoder | null = null;
let timestamp = 0;
let pressing = false;

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

function configureDecoder(ready: StreamReady): void {
  const canvas = canvasRef.value;
  if (!canvas) return;

  canvas.width = ready.width;
  canvas.height = ready.height;

  decoder?.close();
  decoder = new VideoDecoder({
    output: (frame) => {
      const context = canvas.getContext('2d');
      if (context) context.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
    },
    error: (error) => emit('error', error.message),
  });

  const description = ready.description
    ? base64ToBytes(ready.description)
    : undefined;

  decoder.configure({
    codec: ready.videoCodec ?? 'avc1.42E01E',
    description,
    optimizeForLatency: true,
  });
}

function handleBinary(data: ArrayBuffer): void {
  if (!decoder || decoder.state !== 'configured') return;
  const { kind, payload } = decodeFrame(new Uint8Array(data));
  if (kind !== FRAME_KIND.h264) return;

  let isKey = false;
  for (const nal of splitNals(payload)) {
    const type = (nal[0] ?? 0) & 0x1f;
    if (type === 5) {
      isKey = true;
      break;
    }
  }

  try {
    decoder.decode(
      new EncodedVideoChunk({
        type: isKey ? 'key' : 'delta',
        timestamp,
        data: annexBToAvcc(payload),
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
  if (message.t === 'error') {
    emit('error', String(message.message ?? '投屏出错'));
  }
}

function connect(): void {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(
    `${protocol}://${window.location.host}/ws/stream/${props.sessionId}`,
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
  ws.addEventListener('close', () => {
    connected.value = false;
  });
  ws.addEventListener('error', () => ws.close());
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
  if (!controller.value) return;
  (event.target as HTMLElement).setPointerCapture(event.pointerId);
  pressing = true;
  const { x, y } = pointerPosition(event);
  send({ t: 'touch', phase: 'began', x, y, pointerId: 0, pressure: 1 });
}

function onPointerMove(event: PointerEvent): void {
  if (!pressing || !controller.value) return;
  const { x, y } = pointerPosition(event);
  send({ t: 'touch', phase: 'moved', x, y, pointerId: 0, pressure: 1 });
}

function onPointerUp(event: PointerEvent): void {
  if (!pressing) return;
  pressing = false;
  const { x, y } = pointerPosition(event);
  send({ t: 'touch', phase: 'ended', x, y, pointerId: 0, pressure: 0 });
  try {
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);
  } catch {
    /* ignore */
  }
}

function sendKey(
  key: 'home' | 'back' | 'recent' | 'power' | 'volumeUp' | 'volumeDown',
): void {
  if (!controller.value) return;
  send({ t: 'key', key });
}

function sendText(text: string): void {
  if (!controller.value || !text) return;
  send({ t: 'text', text });
}

function sendRotate(): void {
  if (!controller.value) return;
  send({ t: 'rotate' });
}

onMounted(connect);

onBeforeUnmount(() => {
  socket?.close();
  socket = null;
  decoder?.close();
  decoder = null;
});

defineExpose({ sendKey, sendText, sendRotate, controller, connected });
</script>

<template>
  <div class="player">
    <canvas
      ref="canvasRef"
      class="surface"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    />
    <div v-if="starting" class="overlay">正在连接设备…</div>
    <div v-else-if="!connected" class="overlay">连接已断开</div>
  </div>
</template>

<style scoped>
.player {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  background: #000;
}

.surface {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  touch-action: none;
  cursor: crosshair;
  outline: none;
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