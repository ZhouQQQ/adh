import { createRouter, createWebHistory } from 'vue-router';
import AgentsView from './views/AgentsView.vue';
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
      path: '/devices/:id/control',
      name: 'device-control',
      component: DeviceControlView,
      meta: { title: '设备控制', fullscreen: true },
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