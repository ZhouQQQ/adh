<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { NButton, NDropdown, NIcon } from 'naive-ui';
import { ChevronDownOutline, DownloadOutline } from '@vicons/ionicons5';
import { api } from '../api';

withDefaults(
  defineProps<{
    size?: 'tiny' | 'small' | 'medium';
    quaternary?: boolean;
  }>(),
  { size: 'small', quaternary: false },
);

interface PlatformPackage {
  platform: string;
  file: string;
  size: number;
  updatedAt: number;
  source?: 'local' | 'release';
  url?: string;
}

const PLATFORM_LABEL: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

const packages = ref<PlatformPackage[]>([]);
const loading = ref(false);

const options = computed(() =>
  packages.value.map((item) => ({
    key: item.platform,
    label:
      item.size > 0
        ? `${PLATFORM_LABEL[item.platform] ?? item.platform} · ${(item.size / 1024 / 1024).toFixed(1)} MB`
        : `${PLATFORM_LABEL[item.platform] ?? item.platform} · GitHub Release`,
  })),
);

async function load(): Promise<void> {
  loading.value = true;
  try {
    packages.value = (await api.agentPlatforms()).platforms;
  } catch {
    packages.value = [];
  } finally {
    loading.value = false;
  }
}

function download(platform: string): void {
  const target = packages.value.find((item) => item.platform === platform);
  window.location.href = target?.url ?? api.agentPackageUrl(platform);
}

onMounted(load);
</script>

<template>
  <n-dropdown
    trigger="click"
    placement="bottom-end"
    :options="options"
    :disabled="packages.length === 0"
    @select="download"
  >
    <n-button
      :size="size"
      :quaternary="quaternary"
      :loading="loading"
      :disabled="!loading && packages.length === 0"
      :title="
        packages.length === 0
          ? '暂时拿不到 Agent 安装包，请稍后重试'
          : '选择目标平台下载'
      "
    >
      <template #icon>
        <n-icon><DownloadOutline /></n-icon>
      </template>
      下载 Agent
      <n-icon class="chevron" :size="12"><ChevronDownOutline /></n-icon>
    </n-button>
  </n-dropdown>
</template>

<style scoped>
.chevron {
  margin-left: 2px;
  opacity: 0.65;
}
</style>