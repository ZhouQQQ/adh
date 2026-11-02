<script setup lang="ts">
import { useRouter } from 'vue-router';
import { usePreviews, type FloatingPreview } from '../stores/previews';

const router = useRouter();
const { previews, closePreview, focusPreview, updateRect } = usePreviews();

const videos = new Map<string, HTMLVideoElement>();

function setVideo(deviceId: string, element: unknown): void {
  const video = element as HTMLVideoElement | null;
  if (!video) {
    videos.delete(deviceId);
    return;
  }
  videos.set(deviceId, video);
  const item = previews.value.find((entry) => entry.deviceId === deviceId);
  if (item?.stream) video.srcObject = item.stream;
}

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

let gesture: {
  deviceId: string;
  startX: number;
  startY: number;
  at: number;
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
    220,
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

/** 把鼠标坐标换算成视频内容区（object-fit: contain 会有黑边）。 */
function contentPoint(
  event: PointerEvent,
  video: HTMLVideoElement,
): { x: number; y: number } | null {
  const rect = video.getBoundingClientRect();
  const width = video.videoWidth || 1;
  const height = video.videoHeight || 1;
  const scale = Math.min(rect.width / width, rect.height / height);
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  const offsetX = rect.left + (rect.width - drawWidth) / 2;
  const offsetY = rect.top + (rect.height - drawHeight) / 2;
  const x = (event.clientX - offsetX) / drawWidth;
  const y = (event.clientY - offsetY) / drawHeight;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

function onPointerDown(event: PointerEvent, item: FloatingPreview): void {
  if (event.button !== 0) return;
  focusPreview(item.deviceId);
  const video = videos.get(item.deviceId);
  if (!video) return;
  const point = contentPoint(event, video);
  if (!point) return;
  gesture = {
    deviceId: item.deviceId,
    startX: point.x,
    startY: point.y,
    at: Date.now(),
  };
}

function onPointerUp(event: PointerEvent, item: FloatingPreview): void {
  const current = gesture;
  gesture = null;
  if (!current || current.deviceId !== item.deviceId) return;

  const video = videos.get(item.deviceId);
  if (!video) return;
  const point = contentPoint(event, video) ?? { x: current.startX, y: current.startY };

  const distance = Math.hypot(point.x - current.startX, point.y - current.startY);
  if (distance < 0.02) {
    item.tap(current.startX, current.startY);
  } else {
    item.swipe(
      current.startX,
      current.startY,
      point.x,
      point.y,
      Math.min(0.35, Math.max(0.12, (Date.now() - current.at) / 1000)),
    );
  }
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
        </header>

        <div class="win-content">
          <div
            class="win-body"
            @pointerdown="onPointerDown($event, item)"
            @pointerup="onPointerUp($event, item)"
            @pointercancel="onPointerUp($event, item)"
            @contextmenu.prevent
          >
            <video
              :ref="(el) => setVideo(item.deviceId, el)"
              class="win-video"
              autoplay
              muted
              playsinline
            />
          </div>

          <aside class="win-rail">
            <button
              type="button"
              class="rail-btn"
              title="回到控制页"
              @click="goControl(item)"
            >
              ⤢
            </button>
            <button
              type="button"
              class="rail-btn"
              title="主页"
              @click="item.home()"
            >
              ⌂
            </button>
            <button
              type="button"
              class="rail-btn danger"
              title="关闭画中画"
              @click="closePreview(item.deviceId)"
            >
              ×
            </button>
          </aside>
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
  height: 26px;
  padding: 0 10px;
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

.win-content {
  display: flex;
  flex: 1;
  min-height: 0;
}

.win-body {
  position: relative;
  flex: 1;
  min-width: 0;
  background: #000;
  overflow: hidden;
  touch-action: none;
}

.win-video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

/* 竖屏下把操作按钮放到右侧，避免挤占画面 */
.win-rail {
  flex: none;
  width: 30px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 6px 0;
  background: var(--surface);
  border-left: 1px solid var(--border);
}

.rail-btn {
  width: 22px;
  height: 22px;
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

.rail-btn:hover {
  background: var(--surface-2);
  color: var(--text);
}

.rail-btn.danger:hover {
  background: #fef2f2;
  color: #dc2626;
}

.win-resize {
  position: absolute;
  left: 0;
  bottom: 0;
  width: 14px;
  height: 14px;
  cursor: nesw-resize;
  background: linear-gradient(
    -45deg,
    transparent 0 50%,
    var(--border-strong) 50% 100%
  );
  opacity: 0.9;
}
</style>