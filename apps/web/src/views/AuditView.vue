<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import {
  NButton,
  NDataTable,
  NInput,
  NSelect,
  NTag,
  useMessage,
  type DataTableColumns,
  type PaginationProps,
} from 'naive-ui';
import { api, type AuditRecord } from '../api';

const message = useMessage();

const logs = ref<AuditRecord[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const keyword = ref('');
const action = ref('');
const loading = ref(false);

const actionOptions = [
  { label: '全部动作', value: '' },
  { label: '登录', value: 'login' },
  { label: '登录失败', value: 'login.failed' },
  { label: '退出', value: 'logout' },
  { label: '创建用户', value: 'user.create' },
  { label: '更新用户', value: 'user.update' },
  { label: '删除用户', value: 'user.delete' },
  { label: '修改密码', value: 'user.password' },
  { label: '创建节点', value: 'agent.create' },
  { label: '重命名节点', value: 'agent.update' },
  { label: '删除节点', value: 'agent.delete' },
  { label: '重置节点 Key', value: 'agent.rotate' },
  { label: '修改设备', value: 'device.update' },
  { label: '删除设备', value: 'device.delete' },
  { label: '上传设备图片', value: 'device.thumbnail' },
  { label: '上传安装包', value: 'package.upload' },
  { label: '重命名安装包', value: 'package.rename' },
  { label: '删除安装包', value: 'package.delete' },
];

const actionLabel: Record<string, string> = {
  login: '登录',
  'login.failed': '登录失败',
  logout: '退出',
  'user.create': '创建用户',
  'user.update': '更新用户',
  'user.delete': '删除用户',
  'user.password': '修改密码',
  'agent.create': '创建节点',
  'agent.update': '重命名节点',
  'agent.delete': '删除节点',
  'agent.rotate': '重置节点 Key',
  'device.update': '修改设备',
  'device.delete': '删除设备',
  'device.thumbnail': '上传设备图片',
  'package.upload': '上传安装包',
  'package.rename': '重命名安装包',
  'package.update': '编辑安装包',
  'package.delete': '删除安装包',
  http: '操作',
};

const roleLabel: Record<string, string> = {
  superadmin: '超级管理员',
  admin: '管理员',
  operator: '普通用户',
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function actionText(action: string): string {
  return actionLabel[action] ?? action;
}

function userText(row: AuditRecord): string {
  if (!row.username) return '—';
  return row.displayName ? `${row.username}（${row.displayName}）` : row.username;
}

/** 时间范围快捷选项。 */
const RANGE_OPTIONS = [
  { label: '全部时间', value: 'all' },
  { label: '最近 10 分钟', value: '10m' },
  { label: '最近 1 小时', value: '1h' },
  { label: '最近 1 天', value: '1d' },
  { label: '最近 7 天', value: '7d' },
];
const RANGE_MS: Record<string, number> = {
  '10m': 10 * 60_000,
  '1h': 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};
const range = ref<'all' | '10m' | '1h' | '1d' | '7d'>('all');

function sinceValue(): number | undefined {
  if (range.value === 'all') return undefined;
  return Date.now() - (RANGE_MS[range.value] ?? 0);
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await api.listAudit({
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
      username: keyword.value.trim() || undefined,
      action: action.value || undefined,
      since: sinceValue(),
    });
    logs.value = result.logs;
    total.value = result.total;
  } catch (error) {
    message.error(error instanceof Error ? error.message : '读取审计日志失败');
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

const columns: DataTableColumns<AuditRecord> = [
  {
    title: '时间',
    key: 'createdAt',
    width: 170,
    render: (row) => formatTime(row.createdAt),
  },
  {
    title: '用户',
    key: 'username',
    width: 160,
    render: (row) => userText(row),
  },
  {
    title: '角色',
    key: 'role',
    width: 80,
    render: (row) => roleLabel[row.role ?? ''] ?? '—',
  },
  {
    title: '动作',
    key: 'action',
    width: 120,
    render: (row) =>
      h(
        NTag,
        {
          size: 'tiny',
          bordered: false,
          type: row.action === 'login.failed' ? 'error' : 'default',
        },
        { default: () => actionText(row.action) },
      ),
  },
  {
    title: '对象',
    key: 'target',
    width: 120,
    render: (row) => row.target || '—',
  },
  {
    title: '详情',
    key: 'detail',
    minWidth: 220,
    render: (row) => row.detail || row.path || '—',
  },
  {
    title: 'IP',
    key: 'ip',
    width: 120,
    render: (row) => row.ip || '—',
  },
];

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="toolbar">
      <n-input
        v-model:value="keyword"
        size="small"
        clearable
        placeholder="按用户名筛选"
        style="width: 180px"
        @keydown.enter="search"
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
        style="width: 140px"
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