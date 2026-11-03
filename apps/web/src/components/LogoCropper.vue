<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { NButton, NSlider } from 'naive-ui';

const props = defineProps<{ src: string }>();
const emit = defineEmits<{
  confirm: [blob: Blob];
  cancel: [];
}>();

/** 画布尺寸与最终裁剪框（正方形）。 */
const SIZE = 300;
const CROP = 240;

const canvasRef = ref<HTMLCanvasElement | null>(null);
const scale = ref(1);
const minScale = ref(1);
const offsetX = ref(0);
const offsetY = ref(0);
const ready = ref(false);

let image: HTMLImageElement | null = null;
let dragging = false;
let lastX = 0;
let lastY = 0;

function draw(): void {
  const canvas = canvasRef.value;
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx || !image) return;

  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.save();
  ctx.translate(SIZE / 2 + offsetX.value, SIZE / 2 + offsetY.value);
  ctx.scale(scale.value, scale.value);
  ctx.drawImage(image, -image.width / 2, -image.height / 2);
  ctx.restore();
}

function clampOffset(): void {
  if (!image) return;
  const half = CROP / 2;
  const maxX = Math.max(0, (image.width * scale.value) / 2 - half);
  const maxY = Math.max(0, (image.height * scale.value) / 2 - half);
  offsetX.value = Math.min(maxX, Math.max(-maxX, offsetX.value));
  offsetY.value = Math.min(maxY, Math.max(-maxY, offsetY.value));
}

onMounted(() => {
  const img = new Image();
  img.onload = () => {
    image = img;
    minScale.value = Math.max(CROP / img.width, CROP / img.height);
    scale.value = minScale.value;
    ready.value = true;
    draw();
  };
  img.src = props.src;
});

onBeforeUnmount(() => {
  if (props.src.startsWith('blob:')) URL.revokeObjectURL(props.src);
});

function onPointerDown(event: PointerEvent): void {
  dragging = true;
  lastX = event.clientX;
  lastY = event.clientY;
  (event.target as HTMLElement).setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging) return;
  offsetX.value += event.clientX - lastX;
  offsetY.value += event.clientY - lastY;
  lastX = event.clientX;
  lastY = event.clientY;
  clampOffset();
  draw();
}

function onPointerUp(): void {
  dragging = false;
}

function onScaleChange(value: number): void {
  scale.value = value;
  clampOffset();
  draw();
}

function confirm(): void {
  const canvas = canvasRef.value;
  if (!canvas) return;

  const out = document.createElement('canvas');
  out.width = 256;
  out.height = 256;
  const ctx = out.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(
    canvas,
    (SIZE - CROP) / 2,
    (SIZE - CROP) / 2,
    CROP,
    CROP,
    0,
    0,
    256,
    256,
  );
  out.toBlob((blob) => {
    if (blob) emit('confirm', blob);
  }, 'image/png');
}

defineExpose({ confirm });
</script>

<template>
  <div class="cropper">
    <div class="stage">
      <canvas
        ref="canvasRef"
        :width="SIZE"
        :height="SIZE"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      />
      <div class="mask" aria-hidden="true" />
    </div>

    <div class="controls">
      <span class="hint">缩放</span>
      <n-slider
        :value="scale"
        :min="minScale"
        :max="minScale * 4"
        :step="0.01"
        :disabled="!ready"
        style="flex: 1"
        @update:value="onScaleChange"
      />
    </div>

    <div class="actions">
      <n-button size="small" @click="emit('cancel')">取消</n-button>
      <n-button size="small" type="primary" :disabled="!ready" @click="confirm">
        使用这张
      </n-button>
    </div>
  </div>
</template>

<style scoped>
.cropper {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.stage {
  position: relative;
  width: 300px;
  height: 300px;
  margin: 0 auto;
  background: #111;
  border-radius: 10px;
  overflow: hidden;
}

.stage canvas {
  display: block;
  cursor: grab;
  touch-action: none;
}

.stage canvas:active {
  cursor: grabbing;
}

/* 裁剪框外的半透明遮罩 */
.mask {
  position: absolute;
  inset: 30px;
  border-radius: 6px;
  box-shadow:
    0 0 0 9999px rgba(9, 9, 11, 0.55),
    0 0 0 1px rgba(255, 255, 255, 0.85) inset;
  pointer-events: none;
}

.controls {
  display: flex;
  align-items: center;
  gap: 10px;
}

.hint {
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>