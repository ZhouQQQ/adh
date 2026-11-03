<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue';

const props = defineProps<{ visible: boolean; deviceId?: string }>();

const STORAGE_PREFIX = 'adh.safe-keyboard.layout.v5';
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];

interface Layout {
  /** 相对画面宽度的偏移百分比 */
  x: number;
  /** 相对画面高度的偏移百分比 */
  y: number;
  /** 键盘高度，占画面高度的百分比 */
  height: number;
  opacity: number;
}

const DEFAULTS: Layout = { x: 0, y: 0, height: 35, opacity: 0.7 };

/** 每台设备单独记住位置 */
function storageKey(): string {
  return `${STORAGE_PREFIX}.${props.deviceId ?? 'default'}`;
}

function load(): Layout {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return { ...DEFAULTS };
    const value = JSON.parse(raw) as Partial<Layout>;
    return {
      x: Number(value.x ?? DEFAULTS.x),
      y: Number(value.y ?? DEFAULTS.y),
      height: Number(value.height ?? DEFAULTS.height),
      opacity: Number(value.opacity ?? DEFAULTS.opacity),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

const layout = reactive<Layout>(load());
const editing = ref(false);
const rootRef = ref<HTMLElement | null>(null);

/** 手机画面在舞台里的实际显示区域（canvas 按比例缩放后的矩形） */
const frame = reactive({ left: 0, top: 0, width: 100, height: 100 });

watch(
  layout,
  () => {
    try {
      localStorage.setItem(storageKey(), JSON.stringify(layout));
    } catch {
      /* 隐私模式下可能写不了 */
    }
  },
  { deep: true },
);

watch(
  () => props.deviceId,
  () => {
    Object.assign(layout, load());
  },
);

const boardStyle = computed(() => ({
  '--x': String(layout.x),
  '--y': String(layout.y),
  '--h': String(layout.height),
  '--o': String(layout.opacity),
}));

const frameStyle = computed(() => ({
  left: `${frame.left}%`,
  top: `${frame.top}%`,
  width: `${frame.width}%`,
  height: `${frame.height}%`,
}));

function findSurface(): HTMLCanvasElement | null {
  return (
    (rootRef.value?.parentElement?.querySelector(
      'canvas',
    ) as HTMLCanvasElement | null) ?? null
  );
}

function measure(): void {
  const root = rootRef.value;
  if (!root) return;
  const rootRect = root.getBoundingClientRect();
  const surface = findSurface();
  if (!surface || rootRect.width === 0 || rootRect.height === 0) return;

  const rect = surface.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return;

  frame.left = ((rect.left - rootRect.left) / rootRect.width) * 100;
  frame.top = ((rect.top - rootRect.top) / rootRect.height) * 100;
  frame.width = (rect.width / rootRect.width) * 100;
  frame.height = (rect.height / rootRect.height) * 100;
}

function frameRect(): DOMRect {
  return (
    findSurface()?.getBoundingClientRect() ??
    rootRef.value?.getBoundingClientRect() ??
    new DOMRect(0, 0, 1, 1)
  );
}

let measureTimer: number | null = null;

onMounted(() => {
  measure();
  // 会话建立 / 旋转 / 全屏后 canvas 尺寸会变，定时对齐一次
  measureTimer = window.setInterval(measure, 500);
});

interface DragState {
  pointerId: number;
  x: number;
  y: number;
  layout: Layout;
  mode: 'move' | 'resize';
}

let drag: DragState | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function start(mode: 'move' | 'resize', event: PointerEvent): void {
  if (!editing.value) return;
  event.preventDefault();
  event.stopPropagation();
  drag = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    layout: { ...layout },
    mode,
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

function onMove(event: PointerEvent): void {
  if (!drag) return;
  const rect = frameRect();
  const dx = ((event.clientX - drag.x) / rect.width) * 100;
  const dy = ((event.clientY - drag.y) / rect.height) * 100;

  if (drag.mode === 'move') {
    layout.x = clamp(drag.layout.x + dx, -40, 40);
    layout.y = clamp(drag.layout.y + dy, -40, 40);
  } else {
    layout.height = clamp(drag.layout.height - dy, 26, 82);
  }
}

function onUp(): void {
  drag = null;
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  window.removeEventListener('pointercancel', onUp);
}

function toggleEdit(): void {
  editing.value = !editing.value;
}

function reset(): void {
  Object.assign(layout, DEFAULTS);
}

watch(
  () => props.visible,
  async (visible) => {
    if (!visible) {
      editing.value = false;
      return;
    }
    await nextTick();
    measure();
  },
);

onBeforeUnmount(() => {
  if (measureTimer) window.clearInterval(measureTimer);
  onUp();
});
</script>

<template>
  <div v-if="visible" ref="rootRef" class="safe-layer" :class="{ editing }">
    <div class="safe-toolbar">
      <button type="button" @click="toggleEdit">
        {{ editing ? '完成' : '调整位置' }}
      </button>
      <button type="button" @click="reset">重置</button>
      <label v-if="editing" class="opacity">
        透明度
        <input
          v-model.number="layout.opacity"
          type="range"
          min="0.25"
          max="0.95"
          step="0.05"
        />
      </label>
    </div>

    <div class="frame" :style="frameStyle">
      <div class="board" :style="boardStyle" @pointerdown="start('move', $event)">
        <div class="password">
          <span v-for="n in 6" :key="n" class="cell" />
        </div>
        <div class="spacer" />
        <div class="keys">
          <span
            v-for="(key, index) in KEYS"
            :key="index"
            class="key"
            :class="{ blank: !key }"
          >
            {{ key }}
          </span>
        </div>
        <div
          v-if="editing"
          class="resize"
          @pointerdown="start('resize', $event)"
        />
      </div>
    </div>

    <div v-if="editing" class="hint">
      拖动键盘调整位置，拖底部边缘调整高度
    </div>
  </div>
</template>

<style scoped>
.safe-layer {
  position: absolute;
  inset: 0;
  z-index: 9;
  pointer-events: none;
}

.frame {
  position: absolute;
  pointer-events: none;
}

.board {
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 100%;
  height: calc(var(--h) * 1%);
  box-sizing: border-box;
  transform: translate(calc(-50% + var(--x) * 1%), calc(var(--y) * 1%));
  display: flex;
  flex-direction: column;
  padding: 1% 2% 1%;
  background: rgba(250, 250, 250, var(--o));
  color: #18181b;
  border-radius: 8px 8px 0 0;
  pointer-events: none;
  user-select: none;
}

.editing .board {
  pointer-events: auto;
  cursor: move;
  outline: 2px dashed rgba(59, 130, 246, 0.9);
  outline-offset: -2px;
  touch-action: none;
}

.password {
  flex: none;
  height: 10%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.9%;
}

.spacer {
  flex: none;
  height: 28%;
}

.cell {
  height: 78%;
  aspect-ratio: 1.15;
  border-radius: 5px;
  background: rgba(24, 24, 27, 0.1);
}

.keys {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(4, 1fr);
  gap: 2px;
}

.key {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: clamp(14px, 2.8vmin, 30px);
  font-weight: 500;
  background: rgba(255, 255, 255, 0.66);
  border-radius: 4px;
}

.key.blank {
  background: transparent;
}

.safe-toolbar {
  position: absolute;
  top: 46px;
  right: 10px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 6px;
  pointer-events: auto;
}

.safe-toolbar button {
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(10, 10, 11, 0.65);
  color: #fafafa;
  font-size: 12px;
  cursor: pointer;
}

.safe-toolbar button:hover {
  background: rgba(39, 39, 42, 0.85);
}

.opacity {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 6px;
  background: rgba(10, 10, 11, 0.65);
  color: #d4d4d8;
  font-size: 11px;
}

.opacity input {
  width: 72px;
}

.resize {
  position: absolute;
  left: 50%;
  bottom: -6px;
  width: 72px;
  height: 14px;
  margin-left: -36px;
  border-radius: 7px;
  background: rgba(0, 0, 0, 0.4);
  cursor: ns-resize;
}

.hint {
  position: absolute;
  top: 10px;
  left: 10px;
  padding: 5px 9px;
  border-radius: 6px;
  background: rgba(10, 10, 11, 0.65);
  color: #d4d4d8;
  font-size: 11px;
}
</style>