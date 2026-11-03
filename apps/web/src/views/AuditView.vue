<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import {
  NButton,
  NDataTable,
  NInput,
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
const loading = ref(false);

const actionLabel: Record<string, string> = {
  login: '登录',
  'login.failed': '登录失败',
  logout: '退出',
  'user.create': '创建用户',
  'user.update': '更新用户',
  'user.delete': '删除用户',
  http: '操作',
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function actionText(action: string): string {
  return actionLabel[action] ?? action;
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const result = await api.listAudit({
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
      username: keyword.value.trim() || undefined,
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
    width: 120,
    render: (row) => row.username || '—',
  },
  {
    title: '动作',
    key: 'action',
    width: 110,
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
    title: '方法',
    key: 'method',
    width: 70,
    render: (row) => row.method || '—',
  },
  {
    title: '路径 / 目标',
    key: 'path',
    render: (row) => row.target || row.path || '—',
  },
  {
    title: '状态',
    key: 'status',
    width: 70,
    render: (row) =>
      row.status == null
        ? '—'
        : h(
            NTag,
            {
              size: 'tiny',
              bordered: false,
              type: row.status >= 400 ? 'error' : 'success',
            },
            { default: () => String(row.status) },
          ),
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
        v-model:value="keyword"
        size="small"
        clearable
        placeholder="按用户名筛选"
        style="width: 220px"
        @keydown.enter="search"
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
</style>