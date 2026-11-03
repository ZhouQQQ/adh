<script setup lang="ts">
import { computed, h, onMounted, watch } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import {
  NButton,
  NDropdown,
  NIcon,
  NLayout,
  NLayoutContent,
  NLayoutSider,
  NMenu,
  NTag,
  type DropdownOption,
  type MenuOption,
} from 'naive-ui';
import {
  AppsOutline,
  ArrowBackOutline,
  DocumentTextOutline,
  PeopleOutline,
  PhonePortraitOutline,
  ReaderOutline,
  ServerOutline,
  SpeedometerOutline,
} from '@vicons/ionicons5';
import { startFleet, stopFleet, useFleet } from '../stores/fleet';
import { useAuth } from '../stores/auth';
import { usePreviews } from '../stores/previews';
import FloatingPreviews from '../components/FloatingPreviews.vue';

const route = useRoute();
const router = useRouter();
const { agents, devices } = useFleet();
const { previews, closeAllPreviews, focusPreview } = usePreviews();
const { user, isAdmin, loadMe, logout } = useAuth();

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
  if (backTo.value) void router.push(backTo.value);
}

onMounted(() => {
  void loadMe();
  startFleet();
});

const roleLabel = computed(() =>
  user.value?.role === 'admin' ? '管理员' : '操作员',
);

async function handleLogout(): Promise<void> {
  stopFleet();
  await logout();
  await router.replace('/login');
}

watch([user, () => route.meta.admin], () => {
  if (route.meta.admin && user.value && user.value.role !== 'admin') {
    void router.replace('/devices');
  }
});

const menuOptions = computed<MenuOption[]>(() => {
  const deviceChildren: MenuOption[] = [];

  // 仪表盘只有管理员能看
  if (isAdmin.value) {
    deviceChildren.push({
      label: () => h(RouterLink, { to: '/dashboard' }, { default: () => '仪表盘' }),
      key: '/dashboard',
      icon: () => h(NIcon, null, { default: () => h(SpeedometerOutline) }),
    });
  }

  deviceChildren.push(
    {
      label: () => h(RouterLink, { to: '/devices' }, { default: () => '设备管理' }),
      key: '/devices',
      icon: () => h(NIcon, null, { default: () => h(PhonePortraitOutline) }),
    },
    {
      label: () => h(RouterLink, { to: '/apps' }, { default: () => '应用管理' }),
      key: '/apps',
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

  // 操作员只看设备相关菜单
  if (!isAdmin.value) return groups;

  groups.push(
    {
      type: 'group',
      label: '日志',
      key: 'group-logs',
      children: [
        {
          label: () => h(RouterLink, { to: '/audit' }, { default: () => '审计日志' }),
          key: '/audit',
          icon: () => h(NIcon, null, { default: () => h(DocumentTextOutline) }),
        },
        {
          label: () => h(RouterLink, { to: '/device-logs' }, { default: () => '设备日志' }),
          key: '/device-logs',
          icon: () => h(NIcon, null, { default: () => h(ReaderOutline) }),
        },
      ],
    },
    {
      type: 'group',
      label: '系统',
      key: 'group-system',
      children: [
        {
          label: () => h(RouterLink, { to: '/users' }, { default: () => '用户管理' }),
          key: '/users',
          icon: () => h(NIcon, null, { default: () => h(PeopleOutline) }),
        },
        {
          label: () => h(RouterLink, { to: '/agents' }, { default: () => '节点管理' }),
          key: '/agents',
          icon: () => h(NIcon, null, { default: () => h(ServerOutline) }),
        },
      ],
    },
  );

  return groups;
});

const activeKey = computed(() => route.path);
const onlineAgents = computed(
  () => agents.value.filter((agent) => agent.online).length,
);
const onlineDevices = computed(
  () => devices.value.filter((device) => device.status === 'online').length,
);
</script>

<template>
  <n-layout has-sider class="app-shell">
    <n-layout-sider bordered :width="220">
      <div class="brand">
        <div class="brand-mark">A</div>
        <div class="brand-text">
          <strong>设备农场</strong>
          <span>Device Hub</span>
        </div>
      </div>

      <div class="menu-wrap">
        <n-menu :value="activeKey" :options="menuOptions" :indent="14" />
      </div>

      <div class="sider-footer">
        <span class="dot" />
        <span>{{ onlineAgents }} 节点 · {{ onlineDevices }} 设备</span>
      </div>
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
          <div class="user-chip">
            <span class="user-name">
              {{ user?.displayName || user?.username || '未登录' }}
            </span>
            <n-tag size="tiny" :bordered="false">{{ roleLabel }}</n-tag>
            <n-button text size="tiny" @click="handleLogout">退出</n-button>
          </div>
        </div>
      </header>

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

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 56px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 7px;
  background: #18181b;
  border: 1px solid #18181b;
  color: #fafafa;
  font-size: 13px;
  font-weight: 600;
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
  align-items: center;
  gap: 6px;
  height: 40px;
  padding: 0 16px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text-faint);
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