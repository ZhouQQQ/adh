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
import type { SafeKeyboardLayout } from '@adh/protocol';

const props = defineProps<{
  visible: boolean;
  deviceId?: string;
  layout?: SafeKeyboardLayout | null;
  mode?: 'password' | 'full';
}>();

const emit = defineEmits<{ change: [layout: SafeKeyboardLayout] }>();

const STORAGE_PREFIX = 'adh.safe-keyboard.layout.v6';
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
/** 全键盘布局：与 iOS 真机一致（10 / 9 / 9 / 3 键）。 */
const FULL_ROWS = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['⇧', 'z', 'x', 'c', 'v', 'b', 'n', 'm', '⌫'],
  ['123', 'space', 'return'],
];

const DEFAULTS: SafeKeyboardLayout = {
  x: 0,
  y: 0,
  height: 35,
  opacity: 0.7,
  type: 'password',
};

/** 每台设备单独记住位置 */
function storageKey(): string {
  return `${STORAGE_PREFIX}.${props.deviceId ?? 'default'}`;
}

function readLocal(): SafeKeyboardLayout {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return { ...DEFAULTS };
    const value = JSON.parse(raw) as Partial<SafeKeyboardLayout>;
    return {
      x: Number(value.x ?? DEFAULTS.x),
      y: Number(value.y ?? DEFAULTS.y),
      height: Number(value.height ?? DEFAULTS.height),
      opacity: Number(value.opacity ?? DEFAULTS.opacity),
      type: value.type === 'full' ? 'full' : 'password',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** 服务端有配置就用服务端的，否则退回本地缓存 */
function resolveLayout(): SafeKeyboardLayout {
  return props.layout ? { ...props.layout } : readLocal();
}

const layout = reactive<SafeKeyboardLayout>(resolveLayout());
const editing = ref(false);
const rootRef = ref<HTMLElement | null>(null);

/** 手机画面在舞台里的实际显示区域（canvas 按比例缩放后的矩形） */
const frame = reactive({ left: 0, top: 0, width: 100, height: 100 });

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
let saveTimer: number | null = null;
let applying = false;

function writeLocal(): void {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(layout));
  } catch {
    /* 隐私模式下可能写不了 */
  }
}

function scheduleSave(delay = 400): void {
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    emit('change', {
      x: layout.x,
      y: layout.y,
      height: layout.height,
      opacity: layout.opacity,
      type: layout.type,
    });
  }, delay);
}

watch(
  layout,
  () => {
    writeLocal();
    if (!applying) scheduleSave();
  },
  { deep: true },
);

function applyLayout(next: SafeKeyboardLayout): void {
  applying = true;
  Object.assign(layout, next);
  void nextTick(() => {
    applying = false;
  });
}

watch(
  () => [props.visible, props.deviceId, props.mode, JSON.stringify(props.layout ?? null)].join('|'),
  () => {
    if (!props.visible) {
      editing.value = false;
      return;
    }
    applyLayout(resolveLayout());
    // 由外部按钮决定显示密码键盘还是全键盘，类型不跟着服务端旧值走
    if (props.mode && layout.type !== props.mode) {
      layout.type = props.mode;
      if (layout.height === 35 || layout.height === 40) {
        layout.height = props.mode === 'full' ? 40 : 35;
      }
    }
    // 服务端还没有、但本地调过：把本地位置同步上去
    if (!props.layout) scheduleSave(600);
  },
);

interface DragState {
  pointerId: number;
  x: number;
  y: number;
  layout: SafeKeyboardLayout;
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
    layout.height = clamp(drag.layout.height - dy, 20, 82);
  }
}

function onUp(): void {
  if (drag) scheduleSave(0);
  drag = null;
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  window.removeEventListener('pointercancel', onUp);
}

function toggleEdit(): void {
  editing.value = !editing.value;
}

function reset(): void {
  const type = props.mode ?? DEFAULTS.type;
  Object.assign(layout, {
    ...DEFAULTS,
    type,
    height: type === 'full' ? 40 : 35,
  });
}

onMounted(() => {
  measure();
  // 会话建立 / 旋转 / 全屏后 canvas 尺寸会变，定时对齐一次
  measureTimer = window.setInterval(measure, 500);
});

onBeforeUnmount(() => {
  if (measureTimer) window.clearInterval(measureTimer);
  if (saveTimer) window.clearTimeout(saveTimer);
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
        <template v-if="layout.type === 'password'">
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
        </template>
        <div v-else class="full-keys">
          <div
            v-for="(row, rowIndex) in FULL_ROWS"
            :key="rowIndex"
            class="full-row"
            :class="{
              indent: rowIndex === 1,
              bottom: rowIndex === 3,
            }"
          >
            <span
              v-for="key in row"
              :key="key"
              class="full-key"
              :class="{
                'key-space': key === 'space',
                'key-123': key === '123',
                'key-return': key === 'return',
                'key-func': key === '⇧' || key === '⌫',
              }"
            >
              {{ key === 'space' ? 'space' : key }}
            </span>
          </div>
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

/* 全键盘：按 iOS 真机的 10 / 9 / 9 / 3 键比例 */
.full-keys {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 1.2%;
  padding: 3% 2% 5%;
  box-sizing: border-box;
}

.full-row {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 1%;
}

/* 第二行 a~l 两侧各缩进半个键宽 */
.full-row.indent {
  padding: 0 5%;
}

/* 底部 123 / space / return 左右留边 */
.full-row.bottom {
  padding: 0 2%;
}

.full-key {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: clamp(10px, 2.2vmin, 22px);
  font-weight: 500;
  background: rgba(255, 255, 255, 0.66);
  border-radius: 4px;
  overflow: hidden;
  white-space: nowrap;
}

.full-key.key-func {
  flex: 1.35;
  font-size: clamp(9px, 1.8vmin, 18px);
  background: rgba(24, 24, 27, 0.22);
}

.full-key.key-123 {
  flex: 1.5;
  font-size: clamp(9px, 1.8vmin, 18px);
  background: rgba(24, 24, 27, 0.22);
}

.full-key.key-space {
  flex: 4.2;
}

.full-key.key-return {
  flex: 2.2;
  font-size: clamp(9px, 1.8vmin, 18px);
  background: rgba(24, 24, 27, 0.22);
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



