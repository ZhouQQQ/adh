<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  NButton,
  NEmpty,
  NIcon,
  NInput,
  NSelect,
} from 'naive-ui';
import { RefreshOutline, SearchOutline } from '@vicons/ionicons5';
import type { DeviceStatus, Platform } from '@adh/protocol';
import DeviceCard from '../components/DeviceCard.vue';
import { useFleet } from '../stores/fleet';
import { memoryGb } from '../utils/format';

const { devices, agents, refresh } = useFleet();

const keyword = ref('');
const platform = ref<Platform | 'all'>('all');
const status = ref<DeviceStatus | 'all'>('all');
const versions = ref<string[]>([]);
const cpus = ref<string[]>([]);
const memories = ref<number[]>([]);

const platformOptions = [
  { label: '全部类型', value: 'all' },
  { label: 'Android', value: 'android' },
  { label: 'iOS', value: 'ios' },
];

const statusOptions = [
  { label: '全部状态', value: 'all' },
  { label: '在线', value: 'online' },
  { label: '离线', value: 'offline' },
  { label: '未授权', value: 'unauthorized' },
];

const versionOptions = computed(() => {
  const map = new Map<string, { count: number; platform: Platform }>();
  for (const device of devices.value) {
    if (!device.osVersion) continue;
    const entry = map.get(device.osVersion);
    if (entry) entry.count += 1;
    else map.set(device.osVersion, { count: 1, platform: device.platform });
  }
  return [...map.entries()]
    .sort((a, b) =>
      a[0].localeCompare(b[0], 'zh-CN', { numeric: true }),
    )
    .map(([value, info]) => ({
      label: `${info.platform === 'ios' ? 'iOS' : 'Android'} ${value} (${info.count})`,
      value,
    }));
});

const cpuOptions = computed(() => {
  const map = new Map<string, number>();
  for (const device of devices.value) {
    if (!device.cpu) continue;
    map.set(device.cpu, (map.get(device.cpu) ?? 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ label: `${value} (${count})`, value }));
});

const memoryOptions = computed(() => {
  const map = new Map<number, number>();
  for (const device of devices.value) {
    const gb = memoryGb(device.memoryMb);
    if (gb === undefined) continue;
    map.set(gb, (map.get(gb) ?? 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([value, count]) => ({ label: `${value} GB (${count})`, value }));
});

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return devices.value
    .filter((device) => {
      if (platform.value !== 'all' && device.platform !== platform.value) {
        return false;
      }
      if (status.value !== 'all' && device.status !== status.value) return false;
      if (
        versions.value.length > 0 &&
        (!device.osVersion || !versions.value.includes(device.osVersion))
      ) {
        return false;
      }
      if (
        cpus.value.length > 0 &&
        (!device.cpu || !cpus.value.includes(device.cpu))
      ) {
        return false;
      }
      if (memories.value.length > 0) {
        const gb = memoryGb(device.memoryMb);
        if (gb === undefined || !memories.value.includes(gb)) return false;
      }
      if (kw) {
        const haystack = [
          device.name,
          device.model,
          device.brand,
          device.udid,
          device.cpu,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(kw)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      const rank = (s: DeviceStatus) => (s === 'online' ? 0 : s === 'unauthorized' ? 1 : 2);
      const diff = rank(a.status) - rank(b.status);
      return diff !== 0 ? diff : a.name.localeCompare(b.name, 'zh-CN');
    });
});

const agentNames = computed(
  () => new Map(agents.value.map((agent) => [agent.id, agent.name])),
);

function resetFilters(): void {
  keyword.value = '';
  platform.value = 'all';
  status.value = 'all';
  versions.value = [];
  cpus.value = [];
  memories.value = [];
}
</script>

<template>
  <div class="devices-page">
    <div class="toolbar">
      <n-input
        v-model:value="keyword"
        class="search"
        placeholder="搜索名称 / 型号 / UDID / CPU"
        clearable
      >
        <template #prefix>
          <n-icon :component="SearchOutline" />
        </template>
      </n-input>

      <n-select
        v-model:value="platform"
        class="filter"
        :options="platformOptions"
      />
      <n-select
        v-model:value="status"
        class="filter"
        :options="statusOptions"
      />
      <n-select
        v-model:value="versions"
        class="filter wide"
        multiple
        clearable
        placeholder="系统版本"
        :options="versionOptions"
        :max-tag-count="1"
      />
      <n-select
        v-model:value="cpus"
        class="filter cpu"
        multiple
        clearable
        placeholder="CPU"
        :options="cpuOptions"
        :max-tag-count="1"
      />
      <n-select
        v-model:value="memories"
        class="filter"
        multiple
        clearable
        placeholder="内存"
        :options="memoryOptions"
        :max-tag-count="1"
      />

      <n-button quaternary size="small" @click="resetFilters">重置</n-button>
      <n-button quaternary size="small" @click="refresh">
        <template #icon>
          <n-icon :component="RefreshOutline" />
        </template>
      </n-button>

      <span class="result-count">
        {{ filtered.length }} / {{ devices.length }}
      </span>
    </div>

    <div v-if="filtered.length > 0" class="grid">
      <DeviceCard
        v-for="device in filtered"
        :key="device.id"
        :device="device"
        :agent-name="agentNames.get(device.agentId) ?? '未知节点'"
      />
    </div>

    <n-empty
      v-else
      class="empty"
      :description="devices.length === 0 ? '暂无设备接入' : '没有匹配的设备'"
    >
      <template #extra>
        <p v-if="devices.length === 0" class="empty-hint">
          用 USB 连接 Android 设备并开启「USB 调试」，节点会在 5 秒内自动发现。
          若显示「未授权」，请在手机上确认调试授权弹窗。
        </p>
        <n-button v-else size="small" @click="resetFilters">清空筛选条件</n-button>
      </template>
    </n-empty>
  </div>
</template>

<style scoped>
.devices-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background: #18181c;
  border: 1px solid #2a2a30;
  border-radius: 10px;
}

.search {
  width: 240px;
}

.filter {
  width: 118px;
}

.filter.wide {
  width: 170px;
}

.filter.cpu {
  width: 180px;
}

.result-count {
  margin-left: auto;
  font-size: 11px;
  color: #6f6f78;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(246px, 1fr));
  gap: 14px;
}

.empty {
  padding: 48px 0;
}

.empty-hint {
  margin: 0;
  max-width: 460px;
  font-size: 12px;
  line-height: 1.7;
  color: #6f6f78;
}
</style>