<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  NButton,
  NCheckbox,
  NEmpty,
  NInput,
  NModal,
  NTag,
} from 'naive-ui';
import { LogoAndroid, LogoApple, SearchOutline } from '@vicons/ionicons5';
import type { DeviceSummary } from '@adh/protocol';

const props = defineProps<{
  show: boolean;
  devices: DeviceSummary[];
  selected: string[];
}>();

const emit = defineEmits<{
  'update:show': [value: boolean];
  add: [ids: string[]];
}>();

const keyword = ref('');
const platform = ref<'all' | 'android' | 'ios'>('all');
const checked = ref<string[]>([]);

watch(
  () => props.show,
  (visible) => {
    if (!visible) return;
    keyword.value = '';
    platform.value = 'all';
    checked.value = [];
  },
);

const candidates = computed(() => {
  const text = keyword.value.trim().toLowerCase();
  return props.devices
    .filter((device) => !props.selected.includes(device.id))
    .filter((device) =>
      platform.value === 'all' ? true : device.platform === platform.value,
    )
    .filter((device) => {
      if (!text) return true;
      return [device.name, device.model, device.marketName, device.udid, device.osVersion]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(text);
    });
});

const allChecked = computed(
  () =>
    candidates.value.length > 0 &&
    candidates.value.every((device) => checked.value.includes(device.id)),
);

function toggle(id: string): void {
  checked.value = checked.value.includes(id)
    ? checked.value.filter((item) => item !== id)
    : [...checked.value, id];
}

function toggleAll(): void {
  checked.value = allChecked.value
    ? []
    : candidates.value.map((device) => device.id);
}

function close(): void {
  emit('update:show', false);
}

function submit(): void {
  if (checked.value.length === 0) return;
  emit('add', checked.value);
  close();
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="添加设备"
    style="width: 620px"
    :bordered="false"
    @update:show="emit('update:show', $event)"
  >
    <div class="filters">
      <n-input
        v-model:value="keyword"
        size="small"
        clearable
        placeholder="搜索名称 / 型号 / UDID"
        class="search"
      >
        <template #prefix>
          <n-icon :component="SearchOutline" />
        </template>
      </n-input>

      <div class="platforms">
        <button
          v-for="item in [
            { key: 'all', label: '全部' },
            { key: 'android', label: 'Android' },
            { key: 'ios', label: 'iOS' },
          ]"
          :key="item.key"
          type="button"
          class="opt"
          :class="{ active: platform === item.key }"
          @click="platform = item.key as 'all' | 'android' | 'ios'"
        >
          {{ item.label }}
        </button>
      </div>

      <n-checkbox
        :checked="allChecked"
        :disabled="candidates.length === 0"
        @update:checked="toggleAll"
      >
        全选
      </n-checkbox>
    </div>

    <div class="list">
      <n-empty
        v-if="candidates.length === 0"
        description="没有可添加的设备（仅显示在线设备，iOS 需要 WDA 就绪）"
        class="empty"
      />
      <label
        v-for="device in candidates"
        :key="device.id"
        class="row"
        :class="{ checked: checked.includes(device.id) }"
      >
        <n-checkbox
          :checked="checked.includes(device.id)"
          @update:checked="toggle(device.id)"
        />
        <n-icon
          class="icon"
          :size="18"
          :component="device.platform === 'ios' ? LogoApple : LogoAndroid"
        />
        <div class="info">
          <span class="name" :title="device.name">{{ device.name }}</span>
          <span class="meta">
            {{ device.platform === 'ios' ? 'iOS' : 'Android' }}
            {{ device.osVersion ?? '' }}
            <template v-if="device.model"> · {{ device.model }}</template>
            · {{ device.udid }}
          </span>
        </div>
        <n-tag size="tiny" :bordered="false" type="success">在线</n-tag>
      </label>
    </div>

    <template #footer>
      <div class="footer">
        <span class="count">已选 {{ checked.length }} 台</span>
        <n-space>
          <n-button size="small" @click="close">取消</n-button>
          <n-button
            size="small"
            type="primary"
            :disabled="checked.length === 0"
            @click="submit"
          >
            添加
          </n-button>
        </n-space>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.filters {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.search {
  flex: 1;
  min-width: 0;
}

.platforms {
  display: flex;
  gap: 4px;
}

.opt {
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  cursor: pointer;
}

.opt.active {
  background: #18181b;
  border-color: #18181b;
  color: #fafafa;
}

.list {
  max-height: 360px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}

.row:last-child {
  border-bottom: none;
}

.row:hover,
.row.checked {
  background: var(--surface-2);
}

.icon {
  flex: none;
  color: var(--text-dim);
}

.info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.name {
  font-size: 12px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  font-size: 10px;
  color: var(--text-faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  padding: 40px 0;
}

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.count {
  font-size: 11px;
  color: var(--text-faint);
}
</style>