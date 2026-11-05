import { createRouter, createWebHistory } from 'vue-router';
import { BASE_PATH } from './base';
import AgentsView from './views/AgentsView.vue';
import AppsView from './views/AppsView.vue';
import AuditView from './views/AuditView.vue';
import BatchControlView from './views/BatchControlView.vue';
import DashboardView from './views/DashboardView.vue';
import DeviceControlView from './views/DeviceControlView.vue';
import DeviceLogsView from './views/DeviceLogsView.vue';
import DevicesView from './views/DevicesView.vue';
import LoginView from './views/LoginView.vue';
import McpView from './views/McpView.vue';
import SettingsView from './views/SettingsView.vue';
import UsersView from './views/UsersView.vue';

export const router = createRouter({
  history: createWebHistory(BASE_PATH ? `${BASE_PATH}/` : '/'),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: LoginView,
      meta: { title: '登录', public: true },
    },
    { path: '/', redirect: '/devices' },
    {
      path: '/devices',
      name: 'devices',
      component: DevicesView,
      meta: { title: '设备管理' },
    },
    {
      path: '/dashboard',
      name: 'dashboard',
      component: DashboardView,
      meta: { title: '仪表盘', admin: true },
    },
    {
      path: '/devices/batch',
      name: 'batch-control',
      component: BatchControlView,
      meta: { title: '批量控制', backTo: '/devices' },
    },
    {
      path: '/devices/:id/control',
      name: 'device-control',
      component: DeviceControlView,
      meta: { title: '设备控制', fullscreen: true },
    },
    {
      path: '/apps',
      name: 'apps',
      component: AppsView,
      meta: { title: '应用管理' },
    },
    {
      path: '/mcp',
      name: 'mcp',
      component: McpView,
      meta: { title: 'MCP 接入' },
    },
    {
      path: '/agents',
      name: 'agents',
      component: AgentsView,
      meta: { title: '节点管理', super: true },
    },
    {
      path: '/device-logs',
      name: 'device-logs',
      component: DeviceLogsView,
      meta: { title: '设备日志', admin: true },
    },
    {
      path: '/users',
      name: 'users',
      component: UsersView,
      meta: { title: '用户管理', admin: true },
    },
    {
      path: '/audit',
      name: 'audit',
      component: AuditView,
      meta: { title: '审计日志', super: true },
    },
    {
      path: '/settings',
      name: 'settings',
      component: SettingsView,
      meta: { title: '系统设置', super: true },
    },
    { path: '/:pathMatch(.*)*', redirect: '/devices' },
  ],
});

router.beforeEach((to) => {
  const token = localStorage.getItem('adh.token');
  if (!to.meta.public && !token) {
    return { path: '/login', query: { redirect: to.fullPath } };
  }
  if (to.path === '/login' && token) {
    return '/devices';
  }
  return true;
});