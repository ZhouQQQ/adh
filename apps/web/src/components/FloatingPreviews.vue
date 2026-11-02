<script setup lang="ts">
import { useRouter } from 'vue-router';
import DevicePlayer from './DevicePlayer.vue';
import { usePreviews, type FloatingPreview } from '../stores/previews';

const router = useRouter();
const { previews, closePreview, focusPreview, updateRect } = usePreviews();

let drag: {
  deviceId: string;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
} | null = null;

let resize: {
  deviceId: string;
  startX: number;
  startY: number;
  originWidth: number;
  originHeight: number;
} | null = null;

function clampX(x: number, width: number): number {
  return Math.min(Math.max(x, 0), Math.max(0, window.innerWidth - width));
}

function clampY(y: number, height: number): number {
  return Math.min(Math.max(y, 0), Math.max(0, window.innerHeight - height));
}

function startDrag(event: PointerEvent, item: FloatingPreview): void {
  if (event.button !== 0) return;
  event.preventDefault();
  focusPreview(item.deviceId);
  drag = {
    deviceId: item.deviceId,
    startX: event.clientX,
    startY: event.clientY,
    originX: item.x,
    originY: item.y,
  };
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', stopDrag, { once: true });
}

function onDragMove(event: PointerEvent): void {
  if (!drag) return;
  const item = previews.value.find((entry) => entry.deviceId === drag!.deviceId);
  if (!item) return;
  const x = drag.originX + (event.clientX - drag.startX);
  const y = drag.originY + (event.clientY - drag.startY);
  updateRect(item.deviceId, {
    x: clampX(x, item.width),
    y: clampY(y, item.height),
  });
}

function stopDrag(): void {
  drag = null;
  window.removeEventListener('pointermove', onDragMove);
}

function startResize(event: PointerEvent, item: FloatingPreview): void {
  if (event.button !== 0) return;
  event.preventDefault();
  resize = {
    deviceId: item.deviceId,
    startX: event.clientX,
    startY: event.clientY,
    originWidth: item.width,
    originHeight: item.height,
  };
  window.addEventListener('pointermove', onResizeMove);
  window.addEventListener('pointerup', stopResize, { once: true });
}

function onResizeMove(event: PointerEvent): void {
  if (!resize) return;
  const item = previews.value.find(
    (entry) => entry.deviceId === resize!.deviceId,
  );
  if (!item) return;
  const width = Math.max(
    200,
    Math.min(
      window.innerWidth - item.x,
      resize.originWidth + (event.clientX - resize.startX),
    ),
  );
  const height = Math.max(
    320,
    Math.min(
      window.innerHeight - item.y,
      resize.originHeight + (event.clientY - resize.startY),
    ),
  );
  updateRect(item.deviceId, { width, height });
}

function stopResize(): void {
  resize = null;
  window.removeEventListener('pointermove', onResizeMove);
}

function goControl(item: FloatingPreview): void {
  const target = item.deviceId;
  closePreview(item.deviceId);
  void router.push(`/devices/${target}/control`);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="previews.length > 0" class="floating-layer">
      <section
        v-for="(item, index) in previews"
        :key="item.deviceId"
        class="window"
        :style="{
          left: `${item.x}px`,
          top: `${item.y}px`,
          width: `${item.width}px`,
          height: `${item.height}px`,
          zIndex: 2000 + index,
        }"
        @pointerdown="focusPreview(item.deviceId)"
      >
        <header class="win-head" @pointerdown="startDrag($event, item)">
          <span class="win-title" :title="item.deviceName">
            {{ item.deviceName }}
          </span>
          <button
            type="button"
            class="win-btn"
            title="回到控制台"
            @pointerdown.stop
            @click="goControl(item)"
          >
            ⤢
          </button>
          <button
            type="button"
            class="win-btn"
            title="关闭画中画"
            @pointerdown.stop
            @click="closePreview(item.deviceId)"
          >
            ×
          </button>
        </header>
        <div class="win-body">
          <DevicePlayer
            :session-id="item.sessionId"
            :platform="item.platform"
            :device-id="item.deviceId"
            quality="medium"
          />
        </div>
        <span
          class="win-resize"
          title="拖动调整大小"
          @pointerdown.stop.prevent="startResize($event, item)"
        />
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.floating-layer {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 2000;
}

.window {
  position: fixed;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: #000;
  box-shadow: 0 14px 44px rgba(9, 9, 11, 0.32);
  pointer-events: auto;
  overflow: hidden;
}

.win-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 6px 0 10px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  cursor: move;
  user-select: none;
}

.win-title {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.win-btn {
  flex: none;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.win-btn:hover {
  background: var(--surface-2);
  color: var(--text);
}

.win-body {
  position: relative;
  flex: 1;
  min-height: 0;
  background: #000;
}

.win-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 14px;
  height: 14px;
  cursor: nwse-resize;
  background: linear-gradient(
    135deg,
    transparent 0 50%,
    var(--border-strong) 50% 100%
  );
  opacity: 0.9;
}
</style>