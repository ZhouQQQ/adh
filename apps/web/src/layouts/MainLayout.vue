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
import { PhonePortraitOutline, ServerOutline } from '@vicons/ionicons5';
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
    label: () => h(RouterLink, { to: '/agents' }, { default: () => 'Agent 管理' }),
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
      return { type: 'success' as const, text: '实时连接' };
    case 'connecting':
      return { type: 'warning' as const, text: '连接中' };
    default:
      return { type: 'error' as const, text: '已断开' };
  }
});
</script>

<template>
  <n-layout has-sider class="app-shell">
    <n-layout-sider bordered :width="216">
      <div class="brand">
        <div class="brand-mark">ADH</div>
        <div class="brand-text">
          <strong>设备农场</strong>
          <span>Device Hub</span>
        </div>
      </div>
      <n-menu :value="activeKey" :options="menuOptions" :indent="20" />
    </n-layout-sider>

    <n-layout>
      <n-layout-content class="app-content">
        <header class="page-header">
          <h1>{{ (route.meta.title as string) ?? '' }}</h1>
          <div class="summary">
            <span class="summary-item">
              <em>节点</em><b>{{ onlineAgents }}/{{ agents.length }}</b>
            </span>
            <span class="summary-item">
              <em>设备</em><b>{{ onlineDevices }}/{{ devices.length }}</b>
            </span>
            <n-tag :type="connectionMeta.type" size="small" round>
              {{ connectionMeta.text }}
            </n-tag>
          </div>
        </header>

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
  padding: 18px 18px 14px;
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: rgba(24, 160, 88, 0.18);
  color: #63e2b7;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.5px;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}

.brand-text strong {
  font-size: 14px;
}

.brand-text span {
  font-size: 11px;
  color: #6f6f78;
}

.app-content {
  height: 100vh;
  overflow-y: auto;
  padding: 20px 24px 40px;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.page-header h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.summary {
  display: flex;
  align-items: center;
  gap: 18px;
}

.summary-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
}

.summary-item em {
  font-style: normal;
  color: #6f6f78;
}

.summary-item b {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 600;
}
</style>