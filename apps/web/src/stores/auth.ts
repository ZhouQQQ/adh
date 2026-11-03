import { computed, ref } from 'vue';
import { api, type AuthUser } from '../api';

const TOKEN_KEY = 'adh.token';

const token = ref(localStorage.getItem(TOKEN_KEY) ?? '');
const user = ref<AuthUser | null>(null);
const loading = ref(false);

function setToken(value: string): void {
  token.value = value;
  if (value) localStorage.setItem(TOKEN_KEY, value);
  else localStorage.removeItem(TOKEN_KEY);
}

async function login(username: string, password: string): Promise<void> {
  loading.value = true;
  try {
    const result = await api.login(username, password);
    setToken(result.token);
    user.value = result.user;
  } finally {
    loading.value = false;
  }
}

async function loadMe(): Promise<void> {
  if (!token.value) {
    user.value = null;
    return;
  }
  try {
    const result = await api.me();
    user.value = result.user;
    if (!result.user) setToken('');
  } catch {
    /* 401 已由 request 统一处理 */
  }
}

async function logout(): Promise<void> {
  try {
    await api.logout();
  } catch {
    /* 网络异常也继续清理本地状态 */
  }
  setToken('');
  user.value = null;
}

function clear(): void {
  setToken('');
  user.value = null;
}

export function useAuth() {
  return {
    token,
    user,
    loading,
    isAdmin: computed(
      () => user.value?.role === 'admin' || user.value?.role === 'superadmin',
    ),
    isSuper: computed(() => user.value?.role === 'superadmin'),
    canWrite: computed(() => Boolean(user.value)),
    login,
    logout,
    loadMe,
    clear,
    setToken,
  };
}