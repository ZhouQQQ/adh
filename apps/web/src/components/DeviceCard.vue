<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { NIcon, NTag } from 'naive-ui';
import { PhonePortraitOutline } from '@vicons/ionicons5';
import type { DeviceSummary } from '@adh/protocol';
import { thumbnailUrl } from '../api';
import { formatMemory, formatResolution } from '../utils/format';

const props = defineProps<{
  device: DeviceSummary;
  agentName: string;
}>();

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
  const parts: string[] = [];
  if (props.device.brand) parts.push(props.device.brand);
  if (props.device.osVersion) {
    parts.push(
      props.device.platform === 'ios'
        ? `iOS ${props.device.osVersion}`
        : `Android ${props.device.osVersion}`,
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

      <div class="footer">
        <span>{{ formatResolution(device.resolution) }}</span>
        <span class="agent" :title="agentName">{{ agentName }}</span>
      </div>
    </div>
  </article>
</template>

<style scoped>
.device-card {
  display: flex;
  flex-direction: column;
  background: #18181c;
  border: 1px solid #2a2a30;
  border-radius: 12px;
  overflow: hidden;
  transition:
    border-color 0.18s ease,
    transform 0.18s ease;
}

.device-card:hover {
  border-color: #3a3a44;
  transform: translateY(-1px);
}

.device-card.offline {
  opacity: 0.72;
}

.thumb {
  position: relative;
  height: 210px;
  background:
    radial-gradient(circle at 50% 45%, #1d1d24 0%, #101014 70%);
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
  color: #4a4a54;
  font-size: 11px;
}

.platform-tag {
  position: absolute;
  top: 8px;
  left: 8px;
  font-size: 10px;
  letter-spacing: 0.4px;
  background: rgba(16, 16, 20, 0.72);
  color: #9ca3af;
  backdrop-filter: blur(6px);
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
  color: #6f6f78;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.specs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}

.spec {
  font-size: 10px;
  color: #9ca3af;
  background: #232329;
  border-radius: 5px;
  padding: 2px 6px;
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
  color: #5c5c66;
}

.agent {
  max-width: 50%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>