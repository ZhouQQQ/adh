<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import {
  NConfigProvider,
  NDialogProvider,
  NMessageProvider,
  dateZhCN,
  zhCN,
} from 'naive-ui';
import MainLayout from './layouts/MainLayout.vue';
import { useAuth } from './stores/auth';
import { loadSiteSettings } from './stores/site';
import { shadcnTheme } from './theme';

const route = useRoute();
const router = useRouter();
const { clear, loadMe } = useAuth();

const isLogin = computed(() => route.path === '/login');

function onUnauthorized(): void {
  clear();
  if (route.path !== '/login') {
    void router.replace('/login');
  }
}

onMounted(() => {
  window.addEventListener('adh:unauthorized', onUnauthorized);
  void loadSiteSettings();
  if (!isLogin.value) void loadMe();
});

onBeforeUnmount(() => {
  window.removeEventListener('adh:unauthorized', onUnauthorized);
});
</script>

<template>
  <n-config-provider
    :theme-overrides="shadcnTheme"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <n-message-provider>
      <n-dialog-provider>
        <RouterView v-if="isLogin" />
        <MainLayout v-else />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>