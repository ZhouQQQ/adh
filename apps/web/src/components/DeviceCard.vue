<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { NButton, NIcon, NTag } from 'naive-ui';
import { LogoAndroid, LogoApple } from '@vicons/ionicons5';
import {
  FingerPrintOutline,
  HardwareChipOutline,
  PersonOutline,
  PhonePortraitOutline,
  ResizeOutline,
  SpeedometerOutline,
  WifiOutline,
} from '@vicons/ionicons5';
import type { DeviceSummary } from '@adh/protocol';
import DeviceBattery from './DeviceBattery.vue';
import { api } from '../api';
import { useAuth } from '../stores/auth';
import {
  formatMemory,
  formatAgo,
  formatDuration,
  formatResolution,
} from '../utils/format';

const props = defineProps<{
  device: DeviceSummary;
  agentName: string;
  selectable?: boolean;
  selected?: boolean;
}>();

const emit = defineEmits<{
  detail: [device: DeviceSummary];
  control: [device: DeviceSummary];
  select: [id: string];
  kick: [device: DeviceSummary];
}>();

const { user, isAdmin } = useAuth();
const now = ref(Date.now());

const controlName = computed(() =>
  props.device.control
    ? props.device.control.displayName || props.device.control.username
    : '',
);
const controlDuration = computed(() =>
  props.device.control
    ? formatDuration(props.device.control.since, now.value)
    : '',
);
const canKick = computed(
  () =>
    isAdmin.value &&
    Boolean(props.device.control) &&
    props.device.control?.userId !== user.value?.id,
);

/** 别人正在控制时，普通用户的按钮变成「查看」 */
const controlLabel = computed(() =>
  props.device.control &&
  props.device.control.userId !== user.value?.id &&
  !isAdmin.value
    ? '查看'
    : '控制',
);

let clockTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  clockTimer = setInterval(() => {
    now.value = Date.now();
  }, 30_000);
});
onBeforeUnmount(() => {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
});

const statusMeta = computed(() => {
  switch (props.device.status) {
    case 'online':
      return { type: 'success' as const, label: '在线' };
    case 'unauthorized':
      return { type: 'warning' as const, label: '未授权' };
    default:
      return { type: 'default' as const, label: '离线' };
  }
});

const subtitle = computed(
  () =>
    props.device.brand ||
    (props.device.platform === 'ios' ? 'Apple' : '未知品牌'),
);

const osText = computed(() => {
  const device = props.device;
  if (!device.osVersion) return '—';
  return device.platform === 'ios'
    ? `iOS ${device.osVersion}`
    : `Android ${device.osVersion}`;
});

const memoryText = computed(() => formatMemory(props.device.memoryMb));

const resolutionText = computed(() =>
  formatResolution(props.device.resolution),
);

/** Android 在线即可控制；iOS 需要 WDA 已就绪。 */
const canControl = computed(
  () =>
    props.device.status === 'online' &&
    (props.device.platform === 'android' ||
      props.device.capabilities.includes('wda')),
);

const network = ref<{ ip: string | null } | null>(null);
let networkTimer: ReturnType<typeof setInterval> | null = null;

async function loadNetwork(): Promise<void> {
  if (props.device.status !== 'online') {
    network.value = null;
    return;
  }
  try {
    network.value = await api.deviceNetwork(props.device.id);
  } catch {
    network.value = null;
  }
}

function startNetwork(): void {
  stopNetwork();
  void loadNetwork();
  networkTimer = setInterval(() => void loadNetwork(), 30_000);
}

function stopNetwork(): void {
  if (networkTimer) clearInterval(networkTimer);
  networkTimer = null;
}

onMounted(startNetwork);
onBeforeUnmount(stopNetwork);
watch(() => [props.device.id, props.device.status] as const, startNetwork);

const cpuText = computed(() => {
  const device = props.device;
  const parts: string[] = [];
  if (device.cpu) parts.push(device.cpu);
  if (device.cpuCores) parts.push(`${device.cpuCores} 核`);
  return parts.join(' · ') || '—';
});
</script>

<template>
  <article class="device-card" :class="{ offline: device.status !== 'online', selected }">
    <div class="thumb">
      <button
        v-if="selectable"
        type="button"
        class="select-toggle"
        :class="{ checked: selected }"
        :title="selected ? '取消选择' : '选择'"
        @click.stop="emit('select', device.id)"
      >
        <span v-if="selected" class="check">✓</span>
      </button>

      <div class="placeholder" :class="device.platform">
        <n-icon :size="48">
          <LogoAndroid v-if="device.platform === 'android'" />
          <LogoApple v-else />
        </n-icon>
      </div>

      <div
        v-if="device.control"
        class="control-tag"
        :title="`${controlName} 正在控制`"
      >
        <n-icon :size="12"><PersonOutline /></n-icon>
        <span class="control-name">{{ controlName }}</span>
        <span class="control-time">· {{ controlDuration }}</span>
      </div>
      <n-tag
        v-else-if="device.inUse"
        class="usage-tag"
        size="small"
        type="info"
        :bordered="false"
        round
      >
        有人观看
      </n-tag>
      <div class="battery-tag">
        <DeviceBattery
          :device-id="device.id"
          :online="device.status === 'online'"
        />
      </div>

      <n-tag
        class="status-tag"
        size="small"
        :type="statusMeta.type"
        :bordered="false"
        round
      >
        {{ statusMeta.label }}
      </n-tag>
    </div>

    <div class="body">
      <div class="title" :title="device.name">{{ device.name }}</div>
      <div class="subtitle">{{ subtitle }}</div>

      <div class="kv-grid">
        <div class="kv">
          <n-icon class="k" :size="12" title="系统版本">
            <PhonePortraitOutline />
          </n-icon>
          <span class="v">{{ osText }}</span>
        </div>
        <div class="kv">
          <n-icon class="k" :size="12" title="内存">
            <SpeedometerOutline />
          </n-icon>
          <span class="v">{{ memoryText }}</span>
        </div>
        <div class="kv span-2">
          <n-icon class="k" :size="12" title="CPU">
            <HardwareChipOutline />
          </n-icon>
          <span class="v" :title="cpuText">{{ cpuText }}</span>
        </div>
        <div class="kv">
          <n-icon class="k" :size="12" title="分辨率">
            <ResizeOutline />
          </n-icon>
          <span class="v">{{ resolutionText }}</span>
        </div>
        <div class="kv">
          <n-icon class="k" :size="12" title="IP 地址">
            <WifiOutline />
          </n-icon>
          <span class="v mono">{{ network?.ip ?? '—' }}</span>
        </div>
        <div class="kv span-2">
          <n-icon class="k" :size="12" title="UDID">
            <FingerPrintOutline />
          </n-icon>
          <span class="v mono" :title="device.udid">{{ device.udid }}</span>
        </div>
      </div>

      <div v-if="device.status === 'offline'" class="offline-line">
        最后在线 {{ formatAgo(device.lastSeen) }}
      </div>
    </div>

    <div class="actions">
      <n-button size="tiny" quaternary @click="emit('detail', device)">
        详情
      </n-button>
      <n-button
        size="tiny"
        type="primary"
        secondary
        :disabled="!canControl"
        @click="emit('control', device)"
      >
        {{ controlLabel }}
      </n-button>
      <n-button
        v-if="canKick"
        size="tiny"
        type="error"
        quaternary
        @click="emit('kick', device)"
      >
        断开
      </n-button>
    </div>
  </article>
</template>

<style scoped>
.device-card {
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease;
}

.device-card:hover {
  border-color: var(--border-strong);
  background: #fcfcfd;
}

.device-card.offline {
  opacity: 0.65;
}

.thumb {
  position: relative;
  height: 128px;
  background: linear-gradient(180deg, #fafafa 0%, #f4f4f5 100%);
  display: grid;
  place-items: center;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--border-strong);
}

.placeholder.android {
  color: #34a853;
  opacity: 0.85;
}

.placeholder.ios {
  color: #18181b;
  opacity: 0.8;
}

.status-tag {
  position: absolute;
  bottom: 8px;
  left: 8px;
  backdrop-filter: blur(6px);
}

.battery-tag {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
}

.usage-tag {
  position: absolute;
  top: 34px;
  left: 8px;
  backdrop-filter: blur(6px);
}

.control-tag {
  position: absolute;
  top: 34px;
  left: 8px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 180px;
  padding: 3px 9px;
  border-radius: 999px;
  background: rgba(10, 10, 11, 0.72);
  color: #e4e4e7;
  font-size: 10px;
  backdrop-filter: blur(6px);
}

.control-name {
  max-width: 88px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.control-time {
  color: #a1a1aa;
  white-space: nowrap;
}

.select-toggle {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 3;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  border: 1px solid var(--border-strong);
  background: rgba(255, 255, 255, 0.92);
  color: #ffffff;
  cursor: pointer;
  transition:
    background-color 0.12s ease,
    border-color 0.12s ease;
}

.select-toggle.checked {
  background: #18181b;
  border-color: #18181b;
}

.check {
  font-size: 11px;
  line-height: 1;
}

.device-card.selected {
  border-color: #18181b;
  box-shadow: 0 0 0 1px #18181b;
}

.body {
  padding: 12px 14px 13px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.title {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.subtitle {
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kv-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 10px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

.kv {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  font-size: 11.5px;
}

.kv.span-2 {
  grid-column: span 2;
}

.k {
  flex: none;
  color: var(--text-faint);
}

.v {
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.v.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.offline-line {
  margin-top: 6px;
  font-size: 10px;
  color: #b45309;
}

.actions {
  display: flex;
  gap: 6px;
  padding: 0 12px 12px;
}

.actions :deep(.n-button) {
  flex: 1;
}
</style>