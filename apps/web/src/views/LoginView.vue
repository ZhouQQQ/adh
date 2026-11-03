<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { NButton, NInput, useMessage } from 'naive-ui';
import { useAuth } from '../stores/auth';

const router = useRouter();
const message = useMessage();
const { login } = useAuth();

const username = ref('root');
const password = ref('');
const loading = ref(false);

async function submit(): Promise<void> {
  if (!username.value.trim() || !password.value) {
    message.warning('请输入用户名和密码');
    return;
  }
  try {
    await login(username.value.trim(), password.value);
    await router.replace('/devices');
  } catch (error) {
    message.error(error instanceof Error ? error.message : '登录失败');
  }
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-brand">
        <div class="brand-mark">A</div>
        <div class="brand-text">
          <strong>设备农场</strong>
          <span>Device Hub</span>
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

      <p class="login-hint">默认管理员：admin / admin</p>
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

.brand-mark {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: #18181b;
  color: #fafafa;
  font-size: 14px;
  font-weight: 600;
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

.login-hint {
  margin: 18px 0 0;
  font-size: 11px;
  color: var(--text-faint, #a1a1aa);
  text-align: center;
}
</style>