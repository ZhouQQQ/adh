<script setup lang="ts">
import { computed, h, onMounted, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import {
  NButton,
  NDropdown,
  NIcon,
  NInput,
  NLayout,
  NLayoutContent,
  NLayoutSider,
  NMenu,
  NModal,
  NTag,
  useMessage,
  type DropdownOption,
  type MenuOption,
} from 'naive-ui';
import {
  AppsOutline,
  ArrowBackOutline,
  ChevronBackOutline,
  ChevronForwardOutline,
  DocumentTextOutline,
  LinkOutline,
  PeopleOutline,
  PersonCircleOutline,
  PhonePortraitOutline,
  ReaderOutline,
  ServerOutline,
  SettingsOutline,
  SpeedometerOutline,
} from '@vicons/ionicons5';
import { startFleet, stopFleet, useFleet } from '../stores/fleet';
import { useAuth } from '../stores/auth';
import { usePreviews } from '../stores/previews';
import { useSite } from '../stores/site';
import { api } from '../api';
import { withBase } from '../base';
import { APP_VERSION, BUILD_TIME } from '../utils/version';
import FloatingPreviews from '../components/FloatingPreviews.vue';
import ApiKeyModal from '../components/ApiKeyModal.vue';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const { agents, devices } = useFleet();
const { previews, closeAllPreviews, focusPreview } = usePreviews();
const { user, isAdmin, isSuper, loadMe, logout } = useAuth();
const { title: siteTitle, subtitle: siteSubtitle, logoUpdatedAt } = useSite();

const pwdShow = ref(false);
const oldPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const pwdSaving = ref(false);

/** 侧边栏折叠状态存本地，刷新后保持。 */
const collapsed = ref(localStorage.getItem('adh.sider.collapsed') === '1');

function toggleSider(): void {
  collapsed.value = !collapsed.value;
  localStorage.setItem('adh.sider.collapsed', collapsed.value ? '1' : '0');
}

const userMenu = computed<DropdownOption[]>(() => [
  { label: '个人 API Key', key: 'api-key' },
  { label: '修改密码', key: 'password' },
  { type: 'divider', key: 'divider' },
  { label: '退出登录', key: 'logout' },
]);

const apiKeyShow = ref(false);

function onUserMenu(key: string): void {
  if (key === 'api-key') {
    apiKeyShow.value = true;
    return;
  }
  if (key === 'password') {
    oldPassword.value = '';
    newPassword.value = '';
    confirmPassword.value = '';
    pwdShow.value = true;
    return;
  }
  if (key === 'logout') void handleLogout();
}

async function submitPassword(): Promise<void> {
  if (!oldPassword.value) {
    message.warning('请输入原密码');
    return;
  }
  if (newPassword.value.length < 6) {
    message.warning('新密码至少 6 位');
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    message.warning('两次输入的新密码不一致');
    return;
  }

  pwdSaving.value = true;
  try {
    await api.changePassword(oldPassword.value, newPassword.value);
    message.success('密码已修改');
    pwdShow.value = false;
  } catch (error) {
    message.error(error instanceof Error ? error.message : '修改失败');
  } finally {
    pwdSaving.value = false;
  }
}

const previewMenu = computed<DropdownOption[]>(() => {
  if (previews.value.length === 0) return [];
  return [
    ...previews.value.map((item) => ({
      label: item.deviceName,
      key: `focus:${item.deviceId}`,
    })),
    { type: 'divider', key: 'divider' },
    { label: '全部关闭', key: 'close-all' },
  ];
});

function onPreviewMenu(key: string): void {
  if (key === 'close-all') {
    closeAllPreviews();
    return;
  }
  if (key.startsWith('focus:')) focusPreview(key.slice('focus:'.length));
}

/** 页面左上角的返回箭头，由路由 meta.backTo 决定目标。 */
const backTo = computed(() => (route.meta.backTo as string | undefined) ?? null);

function goBack(): void {
  // 批量页自己处理退出：有 AI 任务时先确认、取消任务、断开设备，再关标签页
  if (route.name === 'batch-control') {
    window.dispatchEvent(new Event('adh:batch-exit'));
    return;
  }
  if (backTo.value) void router.push(backTo.value);
}

/** 点击菜单项任意位置都跳转，不再只依赖 label 里的 RouterLink。 */
function onMenuSelect(key: string): void {
  if (key.startsWith('/')) void router.push(key);
}

onMounted(() => {
  void loadMe();
  startFleet();
});

const roleLabel = computed(() => {
  const role = user.value?.role;
  if (role === 'superadmin') return '超级管理员';
  if (role === 'admin') return '管理员';
  return '普通用户';
});

async function handleLogout(): Promise<void> {
  stopFleet();
  await logout();
  await router.replace('/login');
}

watch([user, () => route.meta], () => {
  const current = user.value;
  if (!current) return;
  if (route.meta.super && current.role !== 'superadmin') {
    void router.replace('/devices');
    return;
  }
  if (
    route.meta.admin &&
    current.role !== 'admin' &&
    current.role !== 'superadmin'
  ) {
    void router.replace('/devices');
  }
});

const menuOptions = computed<MenuOption[]>(() => {
  const deviceChildren: MenuOption[] = [];

  // 仪表盘管理员与超级管理员都能看
  if (isAdmin.value) {
    deviceChildren.push({
      label: () => h(RouterLink, { to: '/dashboard' }, { default: () => '仪表盘' }),
      key: '/dashboard',
      title: '仪表盘',
      icon: () => h(NIcon, null, { default: () => h(SpeedometerOutline) }),
    });
  }

  deviceChildren.push(
    {
      label: () => h(RouterLink, { to: '/devices' }, { default: () => '设备管理' }),
      key: '/devices',
      title: '设备管理',
      icon: () => h(NIcon, null, { default: () => h(PhonePortraitOutline) }),
    },
    {
      label: () => h(RouterLink, { to: '/apps' }, { default: () => '应用管理' }),
      key: '/apps',
      title: '应用管理',
      icon: () => h(NIcon, null, { default: () => h(AppsOutline) }),
    },
  );

  const groups: MenuOption[] = [
    {
      type: 'group',
      label: '设备',
      key: 'group-devices',
      children: deviceChildren,
    },
  ];

  // 日志组只有管理员可见
  if (isAdmin.value) {
    const logChildren: MenuOption[] = [];
    if (isSuper.value) {
      logChildren.push({
        label: () => h(RouterLink, { to: '/audit' }, { default: () => '审计日志' }),
        key: '/audit',
        title: '审计日志',
        icon: () => h(NIcon, null, { default: () => h(DocumentTextOutline) }),
      });
    }
    logChildren.push({
      label: () => h(RouterLink, { to: '/device-logs' }, { default: () => '设备日志' }),
      key: '/device-logs',
      title: '设备日志',
      icon: () => h(NIcon, null, { default: () => h(ReaderOutline) }),
    });
    groups.push({
      type: 'group',
      label: '日志',
      key: 'group-logs',
      children: logChildren,
    });
  }

  // 系统组：普通用户只有 MCP 接入，管理员再加用户管理，superadmin 再加节点与设置
  const systemChildren: MenuOption[] = [];
  if (isAdmin.value) {
    systemChildren.push({
      label: () => h(RouterLink, { to: '/users' }, { default: () => '用户管理' }),
      key: '/users',
      title: '用户管理',
      icon: () => h(NIcon, null, { default: () => h(PeopleOutline) }),
    });
  }
  if (isSuper.value) {
    systemChildren.push(
      {
        label: () => h(RouterLink, { to: '/agents' }, { default: () => '节点管理' }),
        key: '/agents',
        title: '节点管理',
        icon: () => h(NIcon, null, { default: () => h(ServerOutline) }),
      },
      {
        label: () => h(RouterLink, { to: '/settings' }, { default: () => '系统设置' }),
        key: '/settings',
        title: '系统设置',
        icon: () => h(NIcon, null, { default: () => h(SettingsOutline) }),
      },
    );
  }
  systemChildren.push({
    label: () => h(RouterLink, { to: '/mcp-access' }, { default: () => 'MCP 接入' }),
    key: '/mcp-access',
    title: 'MCP 接入',
    icon: () => h(NIcon, null, { default: () => h(LinkOutline) }),
  });
  groups.push({
    type: 'group',
    label: '系统',
    key: 'group-system',
    children: systemChildren,
  });

  return groups;
});

const activeKey = computed(() => route.path);
const onlineAgents = computed(
  () => agents.value.filter((agent) => agent.online).length,
);
const onlineDevices = computed(
  () => devices.value.filter((device) => device.status === 'online').length,
);

/** 构建时注入的版本与构建时间，显示在侧边栏底部。 */
const appVersion = APP_VERSION;
const buildTime = BUILD_TIME;
</script>

<template>
  <n-layout has-sider class="app-shell">
    <n-layout-sider
      bordered
      :width="220"
      :collapsed-width="64"
      :collapsed="collapsed"
      collapse-mode="width"
      :show-trigger="false"
    >
      <div class="brand" :class="{ collapsed }">
        <img
          class="brand-logo"
          :src="
            logoUpdatedAt > 0
              ? api.siteLogoUrl(logoUpdatedAt)
              : withBase('/favicon.svg')
          "
          alt="logo"
        />
        <div v-if="!collapsed" class="brand-text">
          <strong>{{ siteTitle }}</strong>
          <span>{{ siteSubtitle }}</span>
        </div>
      </div>

      <div class="menu-wrap">
        <n-menu
          :value="activeKey"
          :options="menuOptions"
          :indent="14"
          :collapsed="collapsed"
          :collapsed-width="64"
          :collapsed-icon-size="18"
          @update:value="onMenuSelect"
        />
      </div>

      <div class="sider-footer" :class="{ collapsed }">
        <div class="sider-stat">
          <span class="dot" />
          <span v-if="!collapsed">
            {{ onlineAgents }} 节点 · {{ onlineDevices }} 设备
          </span>
        </div>
        <div v-if="!collapsed" class="sider-version" :title="`构建于 ${buildTime}`">
          ADH {{ appVersion }} · {{ buildTime }}
        </div>
      </div>

      <button
        type="button"
        class="sider-collapse-btn"
        :title="collapsed ? '展开菜单' : '收起菜单'"
        @click="toggleSider"
      >
        <n-icon :size="15">
          <ChevronForwardOutline v-if="collapsed" />
          <ChevronBackOutline v-else />
        </n-icon>
      </button>
    </n-layout-sider>

    <n-layout class="app-main">
      <header v-if="!route.meta.fullscreen" class="page-header">
        <div class="header-left">
          <n-button
            v-if="backTo"
            quaternary
            circle
            size="small"
            title="返回"
            @click="goBack"
          >
            <template #icon>
              <n-icon><ArrowBackOutline /></n-icon>
            </template>
          </n-button>
          <h1>{{ (route.meta.title as string) ?? '' }}</h1>
        </div>
        <div class="summary">
          <n-dropdown
            v-if="previews.length > 0"
            trigger="click"
            :options="previewMenu"
            @select="onPreviewMenu"
          >
            <n-button size="tiny" quaternary>画中画 {{ previews.length }}</n-button>
          </n-dropdown>
          <n-dropdown
            trigger="click"
            placement="bottom-end"
            :options="userMenu"
            @select="onUserMenu"
          >
            <div class="user-chip" role="button" tabindex="0">
              <n-icon class="user-chip-icon" :size="16">
                <PersonCircleOutline />
              </n-icon>
              <span class="user-name">
                {{ user?.displayName || user?.username || '未登录' }}
              </span>
              <n-tag size="tiny" :bordered="false">{{ roleLabel }}</n-tag>
              <span class="user-caret">▾</span>
            </div>
          </n-dropdown>
        </div>
      </header>

      <n-modal
        v-model:show="pwdShow"
        preset="card"
        title="修改密码"
        style="width: 380px"
        :bordered="false"
      >
        <div class="pwd-form">
          <n-input
            v-model:value="oldPassword"
            type="password"
            show-password-on="click"
            placeholder="原密码"
          />
          <n-input
            v-model:value="newPassword"
            type="password"
            show-password-on="click"
            placeholder="新密码（至少 6 位）"
          />
          <n-input
            v-model:value="confirmPassword"
            type="password"
            show-password-on="click"
            placeholder="确认新密码"
            @keyup.enter="submitPassword"
          />
        </div>
        <template #footer>
          <div class="pwd-footer">
            <n-button size="small" @click="pwdShow = false">取消</n-button>
            <n-button
              size="small"
              type="primary"
              :loading="pwdSaving"
              @click="submitPassword"
            >
              保存
            </n-button>
          </div>
        </template>
      </n-modal>

      <ApiKeyModal v-model:show="apiKeyShow" />

      <n-layout-content
        :class="['app-content', { fullscreen: route.meta.fullscreen }]"
        :native-scrollbar="false"
      >
        <RouterView />
      </n-layout-content>
    </n-layout>

    <FloatingPreviews />
  </n-layout>
</template>

<style scoped>
.app-shell {
  height: 100vh;
}

/* 折叠按钮相对整个 sider 垂直居中 */
:deep(.n-layout-sider) {
  position: relative;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 56px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
}

/* 折叠后只保留品牌图标，居中显示 */
.brand.collapsed {
  justify-content: center;
  padding: 0 18px;
}

.brand-logo {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  object-fit: contain;
  background: var(--surface-2);
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.brand-text strong {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.brand-text span {
  font-size: 11px;
  color: var(--text-faint);
}

.menu-wrap {
  padding: 10px 8px;
}

.menu-wrap :deep(.n-menu-item-group-title) {
  padding: 10px 18px 4px;
  font-size: 11px;
  color: var(--text-faint);
}

.user-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-left: 10px;
  border-left: 1px solid var(--border);
  cursor: pointer;
  border-radius: 6px;
  transition: background-color 0.12s ease;
}

.user-chip:hover {
  background: var(--surface-2);
}

.user-caret {
  font-size: 10px;
  color: var(--text-faint);
}

.user-chip-icon {
  color: var(--text-dim);
}

/* 整块都能触发下拉，点名字或角色标签都算 */
.user-chip > * {
  pointer-events: none;
}

.pwd-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pwd-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.user-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-dim);
}

.sider-footer {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 2px;
  padding: 8px 16px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-faint);
}

/* 折叠时底部只留在线状态点 */
.sider-footer.collapsed {
  align-items: center;
  padding: 8px 0;
}

.sider-collapse-btn {
  position: absolute;
  top: 50%;
  right: 4px;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface);
  color: var(--text-dim);
  cursor: pointer;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
  opacity: 0.65;
  transform: translateY(-50%);
  transition:
    opacity 0.12s ease,
    background-color 0.12s ease,
    color 0.12s ease;
}

.sider-collapse-btn:hover {
  opacity: 1;
  background: var(--bg);
  color: var(--text);
}

.sider-stat {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sider-version {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  opacity: 0.75;
  white-space: nowrap;
}

.dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #22c55e;
}

.app-main {
  height: 100vh;
  display: flex;
  flex-direction: column;
}

/* n-layout 把子节点都塞进内部滚动容器，这里让它变成纵向 flex，
   页头固定、内容自己滚动；直接子选择器避免影响内容区的滚动容器 */
.app-main > :deep(.n-layout-scroll-container) {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.page-header {
  position: sticky;
  top: 0;
  z-index: 20;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 56px;
  padding: 0 24px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.page-header h1 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.summary {
  display: flex;
  align-items: center;
  gap: 8px;
}

.app-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 24px 48px;
}

.app-content.fullscreen {
  padding: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
</style>

