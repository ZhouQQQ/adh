<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NButton, NEmpty, NSelect, NTag, useMessage } from 'naive-ui';
import DevicePlayer from '../components/DevicePlayer.vue';
import BulkInstallModal from '../components/BulkInstallModal.vue';
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

const deviceOptions = computed(() =>
  devices.value
    .filter((device) => device.status === 'online' && device.platform === 'android')
    .map((device) => ({ label: device.name, value: device.id })),
);

const selectedDevices = computed(() =>
  selectedIds.value
    .map((id) => devices.value.find((device) => device.id === id))
    .filter((device): device is NonNullable<typeof device> => Boolean(device)),
);

const installTargets = computed(() =>
  selectedDevices.value.map((device) => ({ id: device.id, name: device.name })),
);

async function syncSessions(): Promise<void> {
  const ids = selectedIds.value;

  for (const id of ids) {
    if (sessions.value[id]) continue;

    connecting.value = { ...connecting.value, [id]: true };
    try {
      const { sessionId } = await api.createStream(id);
      sessions.value = { ...sessions.value, [id]: sessionId };
    } catch (error) {
      const name = devices.value.find((device) => device.id === id)?.name ?? id;
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
}

watch(selectedIds, () => void syncSessions(), { immediate: true });

function removeDevice(id: string): void {
  selectedIds.value = selectedIds.value.filter((item) => item !== id);
}

function onControllerChange(deviceId: string, value: boolean): void {
  controllers.value = { ...controllers.value, [deviceId]: value };
}

function goBack(): void {
  void router.push('/devices');
}
</script>

<template>
  <div class="batch-page">
    <header class="batch-toolbar">
      <span class="batch-title">批量控制</span>
      <n-select
        v-model:value="selectedIds"
        class="device-picker"
        multiple
        filterable
        clearable
        :options="deviceOptions"
        placeholder="添加设备"
        :max-tag-count="2"
      />
      <span class="batch-count">{{ selectedIds.length }} 台</span>
      <n-button
        size="small"
        :disabled="installTargets.length === 0"
        @click="installShow = true"
      >
        批量安装
      </n-button>
      <n-button quaternary size="small" @click="goBack">返回设备列表</n-button>
    </header>

    <div v-if="selectedDevices.length > 0" class="batch-grid">
      <section v-for="device in selectedDevices" :key="device.id" class="tile">
        <div class="tile-header">
          <span class="tile-name" :title="device.name">{{ device.name }}</span>
          <n-tag
            v-if="controllers[device.id] === false"
            size="tiny"
            type="warning"
            :bordered="false"
          >
            只读
          </n-tag>
          <span class="tile-meta">
            {{ device.osVersion ? `Android ${device.osVersion}` : '' }}
          </span>
          <button type="button" class="tile-remove" @click="removeDevice(device.id)">
            移除
          </button>
        </div>
        <div class="tile-stage">
          <DevicePlayer
            v-if="sessions[device.id]"
            :session-id="sessions[device.id]!"
            @controller-change="onControllerChange(device.id, $event)"
          />
          <div v-else class="tile-loading">
            {{ connecting[device.id] ? '连接中…' : '等待连接' }}
          </div>
        </div>
      </section>
    </div>

    <n-empty
      v-else
      class="batch-empty"
      description="在上方选择设备开始批量控制"
    />

    <BulkInstallModal
      v-model:show="installShow"
      :devices="installTargets"
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
}

.batch-title {
  font-size: 14px;
  font-weight: 600;
}

.device-picker {
  width: 360px;
  max-width: 50vw;
}

.batch-count {
  font-size: 11px;
  color: var(--text-faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.batch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 14px;
}

.tile {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  background: var(--surface);
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
  padding: 2px 7px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-faint);
  font-size: 11px;
  cursor: pointer;
}

.tile-remove:hover {
  background: var(--surface-2);
  color: var(--text);
}

.tile-stage {
  position: relative;
  height: 380px;
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