<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import {
  NButton,
  NDataTable,
  NDatePicker,
  NInput,
  NSelect,
  NTag,
  useMessage,
  type DataTableColumns,
  type PaginationProps,
} from 'naive-ui';
import { api, type DeviceLogRecord } from '../api';
import { useFleet } from '../stores/fleet';

const message = useMessage();
const { devices } = useFleet();

const logs = ref<DeviceLogRecord[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const username = ref('');
const action = ref('');
const deviceId = ref('');
const loading = ref(false);

const deviceOptions = computed(() => [
  { label: '全部设备', value: '' },
  ...devices.value.map((device) => ({ label: device.name, value: device.id })),
]);

const actionOptions = [
  { label: '全部动作', value: '' },
  { label: '开始控制', value: 'control.start' },
  { label: '观看投屏', value: 'control.view' },
  { label: '接管控制', value: 'control.takeover' },
  { label: '查看权限', value: 'control.viewers' },
  { label: '切换画质', value: 'control.quality' },
  { label: '断开投屏', value: 'control.stop' },
  { label: '强制断开', value: 'control.kick' },
  { label: '锁定设备', value: 'device.lock' },
  { label: '解除锁定', value: 'device.unlock' },
  { label: '触摸操作', value: 'input.touch' },
  { label: '按键', value: 'input.key' },
  { label: '文本输入', value: 'input.text' },
  { label: '复制到剪贴板', value: 'input.clipboard' },
  { label: '旋转屏幕', value: 'input.rotate' },
  { label: '亮屏 / 息屏', value: 'input.screen' },
  { label: '通知栏', value: 'input.panel' },
  { label: '安装应用', value: 'app.install' },
  { label: '卸载应用', value: 'app.uninstall' },
  { label: '上传文件', value: 'file.upload' },
  { label: '下载文件', value: 'file.download' },
  { label: '删除文件', value: 'file.delete' },
  { label: '重命名', value: 'file.rename' },
  { label: '复制文件', value: 'file.copy' },
  { label: '移动文件', value: 'file.move' },
];

const actionLabel = Object.fromEntries(
  actionOptions.map((item) => [item.value, item.label]),
) as Record<string, string>;

function actionText(value: string): string {
  return actionLabel[value] ?? value;
}

function userText(row: DeviceLogRecord): string {
  if (!row.username) return '—';
  return row.displayName ? `${row.username}（${row.displayName}）` : row.username;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** 时间范围快捷选项。 */
const RANGE_OPTIONS = [
  { label: '全部时间', value: 'all' },
  { label: '最近 10 分钟', value: '10m' },
  { label: '最近 1 小时', value: '1h' },
  { label: '最近 1 天', value: '1d' },
  { label: '最近 7 天', value: '7d' },
  { label: '自定义时间', value: 'custom' },
];
const RANGE_MS: Record<string, number> = {
  '10m': 10 * 60_000,
  '1h': 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};
const range = ref<'all' | '10m' | '1h' | '1d' | '7d' | 'custom'>('all');
const customRange = ref<[number, number] | null>(null);

function sinceValue(): number | undefined {
  if (range.value === 'all') return undefined;
  if (range.value === 'custom') return customRange.value?.[0];
  return Date.now() - (RANGE_MS[range.value] ?? 0);
}

function untilValue(): number | undefined {
  if (range.value !== 'custom') return undefined;
  return customRange.value?.[1];
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await api.listDeviceLogs({
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
      username: username.value.trim() || undefined,
      action: action.value || undefined,
      deviceId: deviceId.value || undefined,
      since: sinceValue(),
      until: untilValue(),
    });
    logs.value = result.logs;
    total.value = result.total;
  } catch (error) {
    message.error(error instanceof Error ? error.message : '读取设备日志失败');
  } finally {
    loading.value = false;
  }
}

function search(): void {
  page.value = 1;
  void load();
}

const pagination = computed<PaginationProps>(() => ({
  page: page.value,
  pageSize: pageSize.value,
  itemCount: total.value,
  showSizePicker: true,
  pageSizes: [20, 50, 100],
  onChange: (value: number) => {
    page.value = value;
    void load();
  },
  onUpdatePageSize: (value: number) => {
    pageSize.value = value;
    page.value = 1;
    void load();
  },
}));

const columns: DataTableColumns<DeviceLogRecord> = [
  {
    title: '时间',
    key: 'createdAt',
    width: 170,
    render: (row) => formatTime(row.createdAt),
  },
  {
    title: '设备',
    key: 'deviceName',
    width: 150,
    render: (row) => row.deviceName || row.deviceId || '—',
  },
  {
    title: '用户',
    key: 'username',
    width: 160,
    render: (row) => userText(row),
  },
  {
    title: '动作',
    key: 'action',
    width: 120,
    render: (row) =>
      h(
        NTag,
        { size: 'tiny', bordered: false },
        { default: () => actionText(row.action) },
      ),
  },
  {
    title: '详情',
    key: 'detail',
    minWidth: 240,
    ellipsis: { tooltip: true },
    render: (row) => row.detail || '—',
  },
  {
    title: 'IP',
    key: 'ip',
    width: 130,
    render: (row) => row.ip || '—',
  },
];

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="toolbar">
      <n-input
        v-model:value="username"
        size="small"
        clearable
        placeholder="按用户名筛选"
        style="width: 160px"
        @keydown.enter="search"
      />
      <n-select
        v-model:value="deviceId"
        size="small"
        filterable
        :options="deviceOptions"
        style="width: 170px"
        @update:value="search"
      />
      <n-select
        v-model:value="action"
        size="small"
        :options="actionOptions"
        style="width: 140px"
        @update:value="search"
      />
      <n-select
        v-model:value="range"
        size="small"
        :options="RANGE_OPTIONS"
        style="width: 130px"
        @update:value="search"
      />
      <n-date-picker
        v-if="range === 'custom'"
        v-model:value="customRange"
        type="datetimerange"
        size="small"
        clearable
        style="width: 340px"
        @update:value="search"
      />
      <n-button size="small" @click="search">查询</n-button>
      <n-button size="small" :loading="loading" @click="load">刷新</n-button>
      <span class="count">共 {{ total }} 条</span>
    </div>

    <n-data-table
      :columns="columns"
      :data="logs"
      :loading="loading"
      :pagination="pagination"
      :bordered="false"
      :single-line="false"
      size="small"
    />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.count {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* 表格紧凑一点 */
.page :deep(.n-data-table-th),
.page :deep(.n-data-table-td) {
  padding: 5px 8px;
  font-size: 12px;
}

.page :deep(.n-data-table-th) {
  font-size: 11px;
  color: var(--text-dim);
}
</style>