<script setup lang="ts">
import { h, onMounted, ref } from 'vue';
import {
  NButton,
  NDataTable,
  NInput,
  NModal,
  NSelect,
  NSpace,
  NSwitch,
  NTag,
  useDialog,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import { api, type Role, type UserRecord } from '../api';
import { useAuth } from '../stores/auth';

const message = useMessage();
const dialog = useDialog();
const { user: current } = useAuth();

const users = ref<UserRecord[]>([]);
const loading = ref(false);

const show = ref(false);
const saving = ref(false);
const editing = ref<UserRecord | null>(null);

const form = ref({
  username: '',
  displayName: '',
  password: '',
  role: 'operator' as Role,
  enabled: true,
});

const roleOptions = [
  { label: '管理员', value: 'admin' },
  { label: '操作员', value: 'operator' },
];

const roleLabel: Record<Role, string> = {
  admin: '管理员',
  operator: '操作员',
};

function roleType(role: Role): 'error' | 'warning' {
  return role === 'admin' ? 'error' : 'warning';
}

function formatTime(ts: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    users.value = (await api.listUsers()).users;
  } catch (error) {
    message.error(error instanceof Error ? error.message : '读取用户失败');
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  editing.value = null;
  form.value = {
    username: '',
    displayName: '',
    password: '',
    role: 'operator',
    enabled: true,
  };
  show.value = true;
}

function openEdit(row: UserRecord): void {
  editing.value = row;
  form.value = {
    username: row.username,
    displayName: row.displayName ?? '',
    password: '',
    role: row.role,
    enabled: row.enabled,
  };
  show.value = true;
}

async function submit(): Promise<void> {
  if (!editing.value) {
    if (!form.value.username.trim() || form.value.password.length < 6) {
      message.warning('用户名必填，密码至少 6 位');
      return;
    }
  }

  saving.value = true;
  try {
    if (editing.value) {
      await api.updateUser(editing.value.id, {
        displayName: form.value.displayName.trim() || null,
        role: form.value.role,
        enabled: form.value.enabled,
        ...(form.value.password ? { password: form.value.password } : {}),
      });
      message.success('用户已更新');
    } else {
      await api.createUser({
        username: form.value.username.trim(),
        password: form.value.password,
        role: form.value.role,
        displayName: form.value.displayName.trim() || null,
      });
      message.success('用户已创建');
    }
    show.value = false;
    await load();
  } catch (error) {
    message.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

function remove(row: UserRecord): void {
  dialog.warning({
    title: '删除用户',
    content: `确定删除用户「${row.username}」吗？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.deleteUser(row.id);
        message.success('已删除');
        await load();
      } catch (error) {
        message.error(error instanceof Error ? error.message : '删除失败');
      }
    },
  });
}

const columns: DataTableColumns<UserRecord> = [
  {
    title: '用户名',
    key: 'username',
    render: (row) =>
      h('div', { style: 'display:flex;align-items:center;gap:6px' }, [
        row.username,
        row.id === current.value?.id
          ? h(NTag, { size: 'tiny', bordered: false }, { default: () => '当前' })
          : null,
      ]),
  },
  {
    title: '显示名',
    key: 'displayName',
    render: (row) => row.displayName || '—',
  },
  {
    title: '角色',
    key: 'role',
    render: (row) =>
      h(
        NTag,
        { size: 'tiny', type: roleType(row.role), bordered: false },
        { default: () => roleLabel[row.role] },
      ),
  },
  {
    title: '状态',
    key: 'enabled',
    render: (row) =>
      h(
        NTag,
        { size: 'tiny', type: row.enabled ? 'success' : 'default', bordered: false },
        { default: () => (row.enabled ? '启用' : '禁用') },
      ),
  },
  {
    title: '最后登录',
    key: 'lastLoginAt',
    render: (row) => formatTime(row.lastLoginAt),
  },
  {
    title: '操作',
    key: 'actions',
    render: (row) =>
      h(NSpace, { size: 4 }, {
        default: () => [
          h(
            NButton,
            { size: 'tiny', quaternary: true, onClick: () => openEdit(row) },
            { default: () => '编辑' },
          ),
          h(
            NButton,
            {
              size: 'tiny',
              quaternary: true,
              disabled: row.id === current.value?.id,
              onClick: () => remove(row),
            },
            { default: () => '删除' },
          ),
        ],
      }),
  },
];

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="toolbar">
      <n-button size="small" type="primary" @click="openCreate">新建用户</n-button>
      <n-button size="small" :loading="loading" @click="load">刷新</n-button>
    </div>

    <n-data-table
      :columns="columns"
      :data="users"
      :loading="loading"
      :bordered="false"
      :single-line="false"
      size="small"
    />

    <n-modal
      v-model:show="show"
      preset="card"
      :title="editing ? `编辑用户 · ${editing.username}` : '新建用户'"
      style="width: 440px"
      :bordered="false"
    >
      <div class="form">
        <label>
          <span>用户名</span>
          <n-input
            v-model:value="form.username"
            :disabled="Boolean(editing)"
            placeholder="英文、数字、_ . -"
          />
        </label>
        <label>
          <span>显示名</span>
          <n-input v-model:value="form.displayName" placeholder="可选" />
        </label>
        <label>
          <span>{{ editing ? '重置密码' : '密码' }}</span>
          <n-input
            v-model:value="form.password"
            type="password"
            show-password-on="click"
            :placeholder="editing ? '留空表示不修改' : '至少 6 位'"
          />
        </label>
        <label>
          <span>角色</span>
          <n-select v-model:value="form.role" :options="roleOptions" />
        </label>
        <label v-if="editing" class="switch-row">
          <span>启用</span>
          <n-switch v-model:value="form.enabled" />
        </label>
      </div>

      <template #footer>
        <div class="footer">
          <n-button size="small" @click="show = false">取消</n-button>
          <n-button size="small" type="primary" :loading="saving" @click="submit">
            保存
          </n-button>
        </div>
      </template>
    </n-modal>
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
  gap: 8px;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.form label {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.form label > span {
  font-size: 12px;
  color: var(--text-dim);
}

.switch-row {
  flex-direction: row !important;
  align-items: center;
  justify-content: space-between;
}

.footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>