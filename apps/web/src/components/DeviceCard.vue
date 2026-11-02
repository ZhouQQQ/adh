<script setup lang="ts">
import { computed } from 'vue';
import { NButton, NIcon, NTag } from 'naive-ui';
import { PhonePortraitOutline } from '@vicons/ionicons5';
import type { DeviceSummary } from '@adh/protocol';
import { formatMemory, formatResolution, formatAgo } from '../utils/format';

const props = defineProps<{
  device: DeviceSummary;
  agentName: string;
}>();

const emit = defineEmits<{
  detail: [device: DeviceSummary];
  control: [device: DeviceSummary];
}>();

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

const cpuText = computed(() => {
  const device = props.device;
  const parts: string[] = [];
  if (device.cpu) parts.push(device.cpu);
  if (device.cpuCores) parts.push(`${device.cpuCores} 核`);
  return parts.join(' · ') || '—';
});
</script>

<template>
  <article class="device-card" :class="{ offline: device.status !== 'online' }">
    <div class="thumb">
      <div class="placeholder">
        <n-icon :size="30"><PhonePortraitOutline /></n-icon>
        <span>{{ device.platform === 'android' ? 'Android' : 'iOS' }}</span>
      </div>

      <n-tag class="platform-tag" size="small" :bordered="false" round>
        {{ device.platform === 'android' ? 'ANDROID' : 'iOS' }}
      </n-tag>
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
          <span class="k">系统版本</span>
          <span class="v">{{ osText }}</span>
        </div>
        <div class="kv">
          <span class="k">内存</span>
          <span class="v">{{ memoryText }}</span>
        </div>
        <div class="kv">
          <span class="k">型号代码</span>
          <span class="v" :title="device.model">{{ device.model ?? '—' }}</span>
        </div>
        <div class="kv">
          <span class="k">分辨率</span>
          <span class="v">{{ resolutionText }}</span>
        </div>
        <div class="kv span-2">
          <span class="k">CPU</span>
          <span class="v" :title="cpuText">{{ cpuText }}</span>
        </div>
        <div class="kv">
          <span class="k">SDK</span>
          <span class="v">{{ device.sdk ?? '—' }}</span>
        </div>
        <div class="kv">
          <span class="k">节点</span>
          <span class="v" :title="agentName">{{ agentName }}</span>
        </div>
        <div class="kv span-2">
          <span class="k">UDID</span>
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
        :disabled="device.platform !== 'android' || device.status !== 'online'"
        @click="emit('control', device)"
      >
        控制
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
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: var(--border-strong);
  font-size: 11px;
}

.platform-tag {
  position: absolute;
  top: 8px;
  left: 8px;
  font-size: 10px;
  letter-spacing: 0.4px;
  background: rgba(255, 255, 255, 0.85);
  color: var(--text-dim);
  backdrop-filter: blur(6px);
  border: 1px solid var(--border);
}

.status-tag {
  position: absolute;
  top: 8px;
  right: 8px;
  backdrop-filter: blur(6px);
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
  align-items: baseline;
  gap: 4px;
  min-width: 0;
  font-size: 10px;
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