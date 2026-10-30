import { createRouter, createWebHistory } from 'vue-router';
import AgentsView from './views/AgentsView.vue';
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
      path: '/agents',
      name: 'agents',
      component: AgentsView,
      meta: { title: 'Agent 管理' },
    },
    { path: '/:pathMatch(.*)*', redirect: '/devices' },
  ],
});