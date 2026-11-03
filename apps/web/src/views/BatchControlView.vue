<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NButton, NEmpty, NIcon, NSelect, NSwitch, NTag, useMessage } from 'naive-ui';
import {
  AddOutline,
  CloseOutline,
  CloudDownloadOutline,
  ReorderTwoOutline,
} from '@vicons/ionicons5';
import type { DeviceSummary, ViewerToStreamMessage } from '@adh/protocol';
import DevicePlayer from '../components/DevicePlayer.vue';
import BulkInstallModal from '../components/BulkInstallModal.vue';
import AddBatchDevicesModal from '../components/AddBatchDevicesModal.vue';
import { api } from '../api';
import { useFleet } from '../stores/fleet';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const { devices } = useFleet();

function parseIds(raw: unknown): string[] {
  const text = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const selectedIds = ref<string[]>(parseIds(route.query.ids));
const sessions = ref<Record<string, string>>({});
const controllers = ref<Record<string, boolean>>({});
const connecting = ref<Record<string, boolean>>({});
const installShow = ref(false);
const addShow = ref(false);
/** 所有设备统一画质，默认中。 */
const quality = ref<'low' | 'medium' | 'high' | 'ultra'>('medium');
const switchingQuality = ref(false);
/** 联动：一台设备的输入同步到其余设备。 */
const linkEnabled = ref(false);
/** 按住 Alt 时临时解除联动。 */
const linkPaused = ref(false);
/** 正在拖动的设备 id，用于排序。 */
const draggingId = ref<string | null>(null);
/** 拖动经过的目标卡片，用于高亮。 */
const dragOverId = ref<string | null>(null);

const playerRefs = new Map<string, InstanceType<typeof DevicePlayer>>();
/** 最近一次正在进行的触摸，临时解除联动时用它补一个 ended，避免其他设备卡住。 */
let lastTouch: { id: string; message: ViewerToStreamMessage } | null = null;

function setPlayerRef(id: string, value: unknown): void {
  if (value) playerRefs.set(id, value as InstanceType<typeof DevicePlayer>);
  else playerRefs.delete(id);
}

function releaseMirrors(): void {
  const pending = lastTouch;
  if (!pending || pending.message.t !== 'touch') return;
  lastTouch = null;
  const end: ViewerToStreamMessage = {
    t: 'touch',
    phase: 'ended',
    x: pending.message.x,
    y: pending.message.y,
    pointerId: 0,
    pressure: 0,
  };
  for (const [id, player] of playerRefs) {
    if (id === pending.id) continue;
    player.applyInput(end);
  }
}

function onInput(sourceId: string, message: ViewerToStreamMessage): void {
  lastTouch =
    message.t === 'touch' && message.phase !== 'ended'
      ? { id: sourceId, message }
      : null;

  if (!linkEnabled.value || linkPaused.value) return;
  for (const [id, player] of playerRefs) {
    if (id === sourceId) continue;
    player.applyInput(message);
  }
}

function onAltDown(event: KeyboardEvent): void {
  if (event.key !== 'Alt' || !linkEnabled.value) return;
  // 阻止 Windows 浏览器把 Alt 用于聚焦菜单栏
  event.preventDefault();
  if (linkPaused.value) return;
  releaseMirrors();
  linkPaused.value = true;
}

function onAltUp(event: KeyboardEvent): void {
  if (event.key !== 'Alt') return;
  linkPaused.value = false;
}

function onWindowBlur(): void {
  if (linkPaused.value) releaseMirrors();
  linkPaused.value = false;
}

onMounted(() => {
  window.addEventListener('keydown', onAltDown);
  window.addEventListener('keyup', onAltUp);
  window.addEventListener('blur', onWindowBlur);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onAltDown);
  window.removeEventListener('keyup', onAltUp);
  window.removeEventListener('blur', onWindowBlur);
});

watch(linkEnabled, (enabled) => {
  if (!enabled) {
    releaseMirrors();
    linkPaused.value = false;
  }
});

const controlDevices = computed(() =>
  devices.value.filter(
    (device) =>
      device.status === 'online' &&
      (device.platform === 'android' || device.capabilities.includes('wda')),
  ),
);

const selectedDevices = computed(() =>
  selectedIds.value
    .map((id) => devices.value.find((device) => device.id === id))
    .filter((device): device is NonNullable<typeof device> => Boolean(device)),
);

/** 批量安装弹窗展示所有选中设备，具体装哪些由 APK / IPA 类型决定。 */
const installTargets = computed(() =>
  selectedDevices.value.map((device) => ({
    id: device.id,
    name: device.name,
    platform: device.platform,
  })),
);

/** 卡片按设备分辨率取宽高比，画面刚好填满，避免四周大片黑边。 */
function tileRatio(device: DeviceSummary): string {
  const resolution = device.resolution;
  return resolution
    ? `${resolution.width} / ${resolution.height}`
    : '9 / 19.5';
}

function addDevices(ids: string[]): void {
  selectedIds.value = [...new Set([...selectedIds.value, ...ids])];
}

let syncing = false;

async function syncSessions(): Promise<void> {
  if (syncing) return;
  syncing = true;

  const ids = selectedIds.value;
  try {
    for (const id of ids) {
      const device = devices.value.find((item) => item.id === id);
      // iOS 走 WDA，不需要 scrcpy 会话
      if (!device || device.platform === 'ios') continue;
      if (sessions.value[id] || connecting.value[id]) continue;

      connecting.value = { ...connecting.value, [id]: true };
      try {
        const { sessionId } = await api.createStream(id, quality.value);
        sessions.value = { ...sessions.value, [id]: sessionId };
      } catch (error) {
        const name = device.name ?? id;
        message.error(
          `${name}: ${error instanceof Error ? error.message : '连接失败'}`,
        );
      } finally {
        const next = { ...connecting.value };
        delete next[id];
        connecting.value = next;
      }
    }

    const nextSessions = { ...sessions.value };
    for (const id of Object.keys(nextSessions)) {
      if (!ids.includes(id)) delete nextSessions[id];
    }
    sessions.value = nextSessions;
  } finally {
    syncing = false;
  }
}

// 只跟随选中项和在线状态变化，避免电量等设备更新反复触建会话
watch(
  [
    selectedIds,
    () => selectedDevices.value.map((item) => `${item.id}:${item.status}`).join('|'),
  ],
  () => void syncSessions(),
  { immediate: true },
);

function removeDevice(id: string): void {
  selectedIds.value = selectedIds.value.filter((item) => item !== id);
}

function onDragStart(id: string, event: DragEvent): void {
  draggingId.value = id;
  dragOverId.value = null;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  }
}

function onDragEnd(): void {
  draggingId.value = null;
  dragOverId.value = null;
}

function onDragLeave(id: string, event: DragEvent): void {
  const current = event.currentTarget as HTMLElement;
  const next = event.relatedTarget as Node | null;
  if (next && current.contains(next)) return;
  if (dragOverId.value === id) dragOverId.value = null;
}

/** 把拖动的设备插到目标设备的位置。 */
function onDrop(targetId: string): void {
  const sourceId = draggingId.value;
  draggingId.value = null;
  dragOverId.value = null;
  if (!sourceId || sourceId === targetId) return;

  const next = [...selectedIds.value];
  const from = next.indexOf(sourceId);
  const to = next.indexOf(targetId);
  if (from < 0 || to < 0) return;

  next.splice(from, 1);
  next.splice(to, 0, sourceId);
  selectedIds.value = next;
}

// 顺序写回 URL，刷新后保持
watch(selectedIds, (ids) => {
  void router.replace({ query: { ...route.query, ids: ids.join(',') } });
});

function onControllerChange(deviceId: string, value: boolean): void {
  controllers.value = { ...controllers.value, [deviceId]: value };
}

async function onQualityChange(
  value: 'low' | 'medium' | 'high' | 'ultra',
): Promise<void> {
  quality.value = value;

  // Android 会话需要按新画质重建；iOS 由 DevicePlayer 重新挂载后拉流
  const androidIds = selectedDevices.value
    .filter((device) => device.platform === 'android' && sessions.value[device.id])
    .map((device) => device.id);
  if (androidIds.length === 0) return;

  switchingQuality.value = true;
  try {
    const next = { ...sessions.value };
    await Promise.all(
      androidIds.map(async (id) => {
        const result = await api.restartStream(id, value);
        next[id] = result.sessionId;
      }),
    );
    sessions.value = next;
  } catch (error) {
    message.error(error instanceof Error ? error.message : '切换画质失败');
  } finally {
    switchingQuality.value = false;
  }
}
</script>

<template>
  <div class="batch-page">
    <header class="batch-toolbar">
      <div class="tool-group">
        <n-button size="small" @click="addShow = true">
          <template #icon>
            <n-icon :component="AddOutline" />
          </template>
          添加设备
        </n-button>
        <n-button
          size="small"
          :disabled="installTargets.length === 0"
          @click="installShow = true"
        >
          <template #icon>
            <n-icon :component="CloudDownloadOutline" />
          </template>
          批量安装
        </n-button>
        <span class="batch-count">{{ selectedIds.length }} 台</span>
      </div>

      <span class="tool-divider" />

      <div class="tool-group">
        <label class="link-switch">
          <n-switch v-model:value="linkEnabled" size="small" />
          <span>联动</span>
        </label>
        <span v-if="linkEnabled" class="link-hint" :class="{ paused: linkPaused }">
          {{ linkPaused ? '已临时解除，松开 Alt 恢复' : '按住 Alt 临时解除' }}
        </span>
      </div>

      <div class="tool-group right">
        <n-select
          v-model:value="quality"
          size="tiny"
          class="quality-select"
          :options="[
            { label: '低画质', value: 'low' },
            { label: '中画质', value: 'medium' },
            { label: '高画质', value: 'high' },
            { label: '极高画质', value: 'ultra' },
          ]"
          :disabled="switchingQuality"
          @update:value="onQualityChange"
        />
      </div>
    </header>

    <TransitionGroup
      v-if="selectedDevices.length > 0"
      name="tile"
      tag="div"
      class="batch-grid"
    >
      <section
        v-for="device in selectedDevices"
        :key="device.id"
        class="tile"
        :class="{
          dragging: draggingId === device.id,
          'drag-over': dragOverId === device.id && draggingId !== device.id,
        }"
        :style="{ '--tile-ratio': tileRatio(device) }"
        @dragover.prevent="dragOverId = device.id"
        @dragleave="onDragLeave(device.id, $event)"
        @drop.prevent="onDrop(device.id)"
      >
        <div class="tile-header">
          <span
            class="tile-drag"
            draggable="true"
            title="拖动排序"
            @dragstart="onDragStart(device.id, $event)"
            @dragend="onDragEnd"
          >
            <n-icon :size="14"><ReorderTwoOutline /></n-icon>
          </span>
          <span class="tile-name" :title="device.name">{{ device.name }}</span>
          <n-tag
            v-if="linkEnabled"
            size="tiny"
            :type="linkPaused ? 'warning' : 'success'"
            :bordered="false"
          >
            {{ linkPaused ? '已解除' : '联动' }}
          </n-tag>
          <n-tag
            v-if="controllers[device.id] === false"
            size="tiny"
            type="warning"
            :bordered="false"
          >
            只读
          </n-tag>
          <span class="tile-meta">
            {{ device.platform === 'ios' ? 'iOS' : 'Android' }}
            {{ device.osVersion ?? '' }}
          </span>
          <button
            type="button"
            class="tile-remove"
            title="移除"
            @click="removeDevice(device.id)"
          >
            <n-icon :size="14"><CloseOutline /></n-icon>
          </button>
        </div>
        <div class="tile-stage">
          <DevicePlayer
            v-if="sessions[device.id] || device.platform === 'ios'"
            :key="`${device.id}-${sessions[device.id] ?? 'ios'}-${quality}`"
            :ref="(el) => setPlayerRef(device.id, el)"
            :session-id="sessions[device.id] ?? ''"
            :platform="device.platform"
            :device-id="device.id"
            :quality="quality"
            flush
            @controller-change="onControllerChange(device.id, $event)"
            @input="onInput(device.id, $event)"
          />
          <div v-else class="tile-loading">
            {{ connecting[device.id] ? '连接中…' : '等待连接' }}
          </div>
        </div>
      </section>
    </TransitionGroup>

    <n-empty
      v-else
      class="batch-empty"
      description="点击右上角「添加设备」开始批量控制"
    />

    <BulkInstallModal
      v-model:show="installShow"
      :devices="installTargets"
    />

    <AddBatchDevicesModal
      v-model:show="addShow"
      :devices="controlDevices"
      :selected="selectedIds"
      @add="addDevices"
    />
  </div>
</template>

<style scoped>
.batch-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 100%;
}

.batch-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}

.tool-group {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.tool-group.right {
  margin-left: auto;
}

.tool-divider {
  flex: none;
  width: 1px;
  height: 18px;
  background: var(--border);
}

.batch-count {
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--surface-2);
  font-size: 11px;
  color: var(--text-dim);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
}

.link-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--surface-2);
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
  white-space: nowrap;
}

.quality-select {
  width: 104px;
  flex: none;
}

.link-hint {
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
}

.link-hint.paused {
  color: #d97706;
}

.batch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 340px));
  justify-content: start;
  align-items: start;
  gap: 10px;
}

.tile {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  background: var(--surface);
  transition: border-color 0.15s ease, box-shadow 0.15s ease, opacity 0.2s ease;
}

.tile.dragging {
  opacity: 0.45;
}

.tile.drag-over {
  border-color: #3b82f6;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.3);
}

/* 排序后卡片平滑移动到新位置 */
.tile-move {
  transition: transform 0.28s cubic-bezier(0.2, 0, 0, 1);
}

.tile-enter-active,
.tile-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.tile-enter-from,
.tile-leave-to {
  opacity: 0;
  transform: scale(0.96);
}

.tile-drag {
  flex: none;
  display: inline-flex;
  align-items: center;
  color: var(--text-faint);
  cursor: grab;
}

.tile-drag:active {
  cursor: grabbing;
}

.tile-drag:hover {
  color: var(--text);
}

.tile-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.tile-name {
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile-meta {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-faint);
  white-space: nowrap;
}

.tile-remove {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
}

.tile-remove:hover {
  background: var(--surface-2);
  color: var(--text);
}

.tile-stage {
  position: relative;
  width: 100%;
  aspect-ratio: var(--tile-ratio, 9 / 19.5);
  background: #000;
}

.tile-loading {
  display: grid;
  place-items: center;
  height: 100%;
  font-size: 12px;
  color: #71717a;
}

.batch-empty {
  padding: 60px 0;
}
</style>