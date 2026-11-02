<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NButton, NIcon, NTag } from 'naive-ui';
import { PhonePortraitOutline } from '@vicons/ionicons5';
import type { DeviceSummary } from '@adh/protocol';
import { thumbnailUrl } from '../api';
import { formatMemory, formatResolution, formatAgo } from '../utils/format';

const props = defineProps<{
  device: DeviceSummary;
  agentName: string;
}>();

const emit = defineEmits<{
  detail: [device: DeviceSummary];
  control: [device: DeviceSummary];
}>();

const shortUdid = computed(() => {
  const udid = props.device.udid;
  return udid.length > 12 ? `…${udid.slice(-12)}` : udid;
});

const broken = ref(false);
const imageUrl = computed(() => thumbnailUrl(props.device));
const hasImage = computed(
  () => props.device.thumbnailAt > 0 && !broken.value,
);

watch(imageUrl, () => {
  broken.value = false;
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

const subtitle = computed(() => {
  const device = props.device;
  const parts: string[] = [];
  if (device.brand) parts.push(device.brand);
  if (device.model && device.model !== device.name) parts.push(device.model);
  if (device.osVersion) {
    parts.push(
      device.platform === 'ios' ? `iOS ${device.osVersion}` : `Android ${device.osVersion}`,
    );
  }
  return parts.join(' · ') || '未知系统';
});
</script>

<template>
  <article class="device-card" :class="{ offline: device.status !== 'online' }">
    <div class="thumb">
      <img v-if="hasImage" :src="imageUrl" alt="" @error="broken = true" />
      <div v-else class="placeholder">
        <n-icon :size="30"><PhonePortraitOutline /></n-icon>
        <span>暂无画面</span>
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

      <div class="specs">
        <span class="spec" :title="device.cpu ?? '未知 CPU'">
          {{ device.cpu ?? '未知 CPU' }}
        </span>
        <span class="spec">{{ device.cpuCores ? `${device.cpuCores} 核` : '—' }}</span>
        <span class="spec">{{ formatMemory(device.memoryMb) }}</span>
      </div>

      <div class="details">
        <div class="detail-row">
          <span class="k">分辨率</span>
          <span class="v">{{ formatResolution(device.resolution) }}</span>
        </div>
        <div class="detail-row">
          <span class="k">型号</span>
          <span class="v" :title="device.model">{{ device.model ?? '—' }}</span>
        </div>
        <div class="detail-row">
          <span class="k">SDK</span>
          <span class="v">{{ device.sdk ?? '—' }}</span>
        </div>
        <div class="detail-row">
          <span class="k">节点</span>
          <span class="v" :title="agentName">{{ agentName }}</span>
        </div>
        <div class="detail-row">
          <span class="k">UDID</span>
          <span class="v mono" :title="device.udid">{{ shortUdid }}</span>
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
        实时控制
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
  height: 210px;
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

.specs {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 2px;
}

.spec {
  font-size: 10px;
  color: var(--text-muted);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.footer {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 2px;
  font-size: 10px;
  color: var(--text-faint);
}

.agent {
  max-width: 50%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.details {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 10px;
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

.detail-row {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
  font-size: 10px;
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