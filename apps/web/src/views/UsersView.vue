<script setup lang="ts">
import { computed, h, onMounted, ref } from 'vue';
import {
  NButton,
  NDataTable,
  NIcon,
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
import {
  CheckmarkCircleOutline,
  CloseCircleOutline,
} from '@vicons/ionicons5';
import { api, type Role, type UserRecord } from '../api';
import { useAuth } from '../stores/auth';

const message = useMessage();
const dialog = useDialog();
const { user: current, isSuper } = useAuth();

const users = ref<UserRecord[]>([]);
const loading = ref(false);
const keyword = ref('');

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

const roleOptions = computed(() =>
  isSuper.value
    ? [
        { label: '超级管理员', value: 'superadmin' },
        { label: '管理员', value: 'admin' },
        { label: '普通用户', value: 'operator' },
      ]
    : [{ label: '普通用户', value: 'operator' }],
);

const visibleRoles = computed(() =>
  isSuper.value
    ? [
        { value: 'superadmin', short: '超级管理员' },
        { value: 'admin', short: '管理员' },
        { value: 'operator', short: '普通用户' },
      ]
    : [{ value: 'operator', short: '普通用户' }],
);

/** 角色权限矩阵，用于新建用户时的提示。 */
const PERMISSIONS: Array<{
  name: string;
  superadmin: boolean;
  admin: boolean;
  operator: boolean;
}> = [
  { name: '查看设备列表', superadmin: true, admin: true, operator: true },
  { name: '控制 / 观看投屏', superadmin: true, admin: true, operator: true },
  { name: '接管他人控制', superadmin: true, admin: true, operator: false },
  { name: '强制断开投屏', superadmin: true, admin: true, operator: false },
  { name: '锁定 / 解锁设备', superadmin: true, admin: true, operator: false },
  { name: '设备日志', superadmin: true, admin: true, operator: false },
  { name: '应用管理', superadmin: true, admin: true, operator: true },
  { name: '用户管理', superadmin: true, admin: true, operator: false },
  { name: '审计日志', superadmin: true, admin: false, operator: false },
  { name: '仪表盘', superadmin: true, admin: false, operator: false },
  { name: '节点管理', superadmin: true, admin: false, operator: false },
  { name: '系统设置', superadmin: true, admin: false, operator: false },
];

function hasPermission(item: (typeof PERMISSIONS)[number], role: string): boolean {
  if (role === 'superadmin') return item.superadmin;
  if (role === 'admin') return item.admin;
  return item.operator;
}

const roleLabel: Record<Role, string> = {
  superadmin: '超级管理员',
  admin: '管理员',
  operator: '普通用户',
};

function roleType(role: Role): 'error' | 'warning' | 'success' {
  if (role === 'superadmin') return 'error';
  return role === 'admin' ? 'warning' : 'success';
}

function formatTime(ts: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

const roleFilter = ref<'all' | Role>('all');

const roleFilterOptions = computed(() => [
  { label: '全部角色', value: 'all' },
  ...visibleRoles.value.map((item) => ({
    label: item.short,
    value: item.value,
  })),
]);

const filteredUsers = computed(() => {
  const text = keyword.value.trim().toLowerCase();
  return users.value.filter((user) => {
    if (roleFilter.value !== 'all' && user.role !== roleFilter.value) {
      return false;
    }
    if (!text) return true;
    const haystack = `${user.username} ${user.displayName ?? ''} ${
      roleLabel[user.role] ?? ''
    }`.toLowerCase();
    return haystack.includes(text);
  });
});

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
  if (!isSuper.value && row.role !== 'operator') {
    message.warning('管理员只能管理普通用户');
    return;
  }
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
    render: (row) => {
      // 管理员只能管理普通用户，避免越权
      const canManage = isSuper.value || row.role === 'operator';
      return h(NSpace, { size: 4 }, {
        default: () => [
          h(
            NButton,
            {
              size: 'tiny',
              quaternary: true,
              disabled: !canManage,
              onClick: () => openEdit(row),
            },
            { default: () => '编辑' },
          ),
          h(
            NButton,
            {
              size: 'tiny',
              quaternary: true,
              disabled: !canManage || row.id === current.value?.id,
              onClick: () => remove(row),
            },
            { default: () => '删除' },
          ),
        ],
      });
    },
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
        placeholder="搜索用户名 / 显示名"
        style="width: 220px"
      />
      <n-select
        v-model:value="roleFilter"
        size="small"
        :options="roleFilterOptions"
        style="width: 150px"
      />
      <n-button size="small" type="primary" @click="openCreate">新建用户</n-button>
      <n-button size="small" :loading="loading" @click="load">刷新</n-button>
    </div>

    <n-data-table
      :columns="columns"
      :data="filteredUsers"
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

        <div class="perm">
          <div class="perm-title">角色权限说明</div>
          <div class="perm-table">
            <div
              class="perm-row head"
              :style="{ gridTemplateColumns: `1fr repeat(${visibleRoles.length}, 76px)` }"
            >
              <span class="perm-name">权限</span>
              <span
                v-for="role in visibleRoles"
                :key="role.value"
                class="perm-role"
                :class="{ active: form.role === role.value }"
              >
                {{ role.short }}
              </span>
            </div>
            <div
              v-for="item in PERMISSIONS"
              :key="item.name"
              class="perm-row"
              :style="{ gridTemplateColumns: `1fr repeat(${visibleRoles.length}, 76px)` }"
            >
              <span class="perm-name">{{ item.name }}</span>
              <span
                v-for="role in visibleRoles"
                :key="role.value"
                class="perm-cell"
                :class="{ active: form.role === role.value }"
              >
                <n-icon
                  :size="15"
                  :color="hasPermission(item, role.value) ? '#22c55e' : '#ef4444'"
                >
                  <CheckmarkCircleOutline v-if="hasPermission(item, role.value)" />
                  <CloseCircleOutline v-else />
                </n-icon>
              </span>
            </div>
          </div>
        </div>
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

.perm {
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.perm-title {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--text-dim);
}

.perm-table {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.perm-row {
  display: grid;
  align-items: center;
  padding: 4px 10px;
  font-size: 12px;
  border-top: 1px solid var(--border);
}

.perm-row:first-child {
  border-top: none;
}

.perm-row.head {
  background: var(--surface-2);
  font-weight: 600;
}

.perm-name {
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.perm-role {
  text-align: center;
  font-size: 11px;
  color: var(--text-faint);
}

.perm-role.active {
  color: var(--text);
}

.perm-cell {
  display: flex;
  justify-content: center;
}

.perm-cell.active {
  background: rgba(34, 197, 94, 0.08);
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