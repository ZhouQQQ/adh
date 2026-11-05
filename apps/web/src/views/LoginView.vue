<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NButton, NInput, useMessage } from 'naive-ui';
import { useAuth } from '../stores/auth';
import { useSite } from '../stores/site';
import { api } from '../api';
import { withBase } from '../base';
import { APP_VERSION, BUILD_TIME } from '../utils/version';

const route = useRoute();
const router = useRouter();
const message = useMessage();
const { login } = useAuth();
const { title: siteTitle, subtitle: siteSubtitle, logoUpdatedAt } = useSite();

const username = ref('');
const password = ref('');
const loading = ref(false);

onMounted(() => {
  // 账号在其他位置登录时提示一次
  if (localStorage.getItem('adh.kicked') === '1') {
    localStorage.removeItem('adh.kicked');
    message.warning('账号已在其他位置登录，请重新登录');
  }
});

async function submit(): Promise<void> {
  if (!username.value.trim() || !password.value) {
    message.warning('请输入用户名和密码');
    return;
  }
  try {
    await login(username.value.trim(), password.value);
    // 分享链接会带 ?redirect=/devices/xxx/control，登录后直接回到目标页面
    const redirect = route.query.redirect;
    const target =
      typeof redirect === 'string' &&
      redirect.startsWith('/') &&
      !redirect.startsWith('//')
        ? redirect
        : '/devices';
    await router.replace(target);
  } catch (error) {
    message.error(error instanceof Error ? error.message : '登录失败');
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-brand">
        <img
          class="brand-logo"
          :src="
            logoUpdatedAt > 0
              ? api.siteLogoUrl(logoUpdatedAt)
              : withBase('/favicon.svg')
          "
          alt="logo"
        />
        <div class="brand-text">
          <strong>{{ siteTitle }}</strong>
          <span>{{ siteSubtitle }}</span>
        </div>
      </div>

      <form class="login-form" @submit.prevent="submit">
        <n-input
          v-model:value="username"
          size="large"
          placeholder="用户名"
          :input-props="{ autocomplete: 'username' }"
        />
        <n-input
          v-model:value="password"
          type="password"
          show-password-on="click"
          size="large"
          placeholder="密码"
          :input-props="{ autocomplete: 'current-password' }"
        />
        <n-button
          type="primary"
          size="large"
          block
          attr-type="submit"
          :loading="loading"
        >
          登录
        </n-button>
      </form>
    </div>
    <div class="login-version">
      ADH {{ APP_VERSION }} · 构建于 {{ BUILD_TIME }}
    </div>
  </div>
</template>

<style scoped>
.login-page {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: 24px;
  background: var(--bg, #f6f6f7);
}

.login-version {
  position: fixed;
  bottom: 16px;
  left: 0;
  right: 0;
  text-align: center;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  color: var(--text-faint, #a1a1aa);
  opacity: 0.8;
}

.login-card {
  width: 100%;
  max-width: 360px;
  padding: 28px;
  border: 1px solid var(--border, #e4e4e7);
  border-radius: 14px;
  background: var(--surface, #fff);
  box-shadow: 0 18px 50px rgba(15, 23, 42, 0.08);
}

.login-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 24px;
}

.brand-logo {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  object-fit: contain;
}

.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.brand-text strong {
  font-size: 14px;
  font-weight: 600;
}

.brand-text span {
  font-size: 11px;
  color: var(--text-faint, #a1a1aa);
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>