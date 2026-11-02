<script setup lang="ts">
import { computed, h, onMounted } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import {
  NIcon,
  NLayout,
  NLayoutContent,
  NLayoutSider,
  NMenu,
  NTag,
} from 'naive-ui';
import { AppsOutline, PhonePortraitOutline, ServerOutline } from '@vicons/ionicons5';
import { startFleet, useFleet } from '../stores/fleet';

const route = useRoute();
const { agents, devices, connection } = useFleet();

onMounted(() => startFleet());

const menuOptions = [
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
  {
    label: () => h(RouterLink, { to: '/agents' }, { default: () => '节点管理' }),
    key: '/agents',
    icon: () => h(NIcon, null, { default: () => h(ServerOutline) }),
  },
];

const activeKey = computed(() => route.path);
const onlineAgents = computed(
  () => agents.value.filter((agent) => agent.online).length,
);
const onlineDevices = computed(
  () => devices.value.filter((device) => device.status === 'online').length,
);

const connectionMeta = computed(() => {
  switch (connection.value) {
    case 'online':
      return { type: 'success' as const, text: '实时' };
    case 'connecting':
      return { type: 'warning' as const, text: '连接中' };
    default:
      return { type: 'error' as const, text: '已断开' };
  }
});
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
        <h1>{{ (route.meta.title as string) ?? '' }}</h1>
        <div class="summary">
          <n-tag :type="connectionMeta.type" size="small" :bordered="false" round>
            {{ connectionMeta.text }}
          </n-tag>
        </div>
      </header>

      <n-layout-content
        :class="['app-content', { fullscreen: route.meta.fullscreen }]"
        :native-scrollbar="false"
      >
        <RouterView />
      </n-layout-content>
    </n-layout>
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

.page-header {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 56px;
  padding: 0 24px;
  border-bottom: 1px solid var(--border);
}

.page-header h1 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.01em;
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