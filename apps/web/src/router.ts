import { createRouter, createWebHistory } from 'vue-router';
import AgentsView from './views/AgentsView.vue';
import AppsView from './views/AppsView.vue';
import BatchControlView from './views/BatchControlView.vue';
import DeviceControlView from './views/DeviceControlView.vue';
import DevicesView from './views/DevicesView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/devices' },
    {
      path: '/devices',
      name: 'devices',
      component: DevicesView,
      meta: { title: '设备管理' },
    },
    {
      path: '/devices/batch',
      name: 'batch-control',
      component: BatchControlView,
      meta: { title: '批量控制' },
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
      path: '/agents',
      name: 'agents',
      component: AgentsView,
      meta: { title: '节点管理' },
    },
    { path: '/:pathMatch(.*)*', redirect: '/devices' },
  ],
});