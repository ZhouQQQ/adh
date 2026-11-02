<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  NButton,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NInput,
  NSpin,
  NSwitch,
  useDialog,
  useMessage,
} from 'naive-ui';
import { api } from '../api';

const props = defineProps<{
  show: boolean;
  deviceId: string;
  deviceName: string;
}>();

const emit = defineEmits<{ 'update:show': [value: boolean] }>();

const message = useMessage();
const dialog = useDialog();

const apps = ref<{ name: string; version: string | null }[]>([]);
const loading = ref(false);
const includeSystem = ref(false);
const keyword = ref('');

const title = computed(() => `已装应用 · ${props.deviceName}`);

const filtered = computed(() => {
  const text = keyword.value.trim().toLowerCase();
  if (!text) return apps.value;
  return apps.value.filter(
    (pkg) =>
      pkg.name.toLowerCase().includes(text) ||
      appLabel(pkg.name).toLowerCase().includes(text),
  );
});

watch(
  () => props.show,
  (visible) => {
    if (visible) void loadApps();
  },
);

const APP_NAMES: Record<string, string> = {
  'com.tencent.mm': '微信',
  'com.tencent.mobileqq': 'QQ',
  'com.tencent.wework': '企业微信',
  'com.tencent.qqmusic': 'QQ 音乐',
  'com.tencent.news': '腾讯新闻',
  'com.tencent.weread': '微信读书',
  'com.tencent.tmgp.sgame': '王者荣耀',
  'com.tencent.tmgp.pubgmhd': '和平精英',
  'com.eg.android.AlipayGphone': '支付宝',
  'com.taobao.taobao': '淘宝',
  'com.taobao.idlefish': '闲鱼',
  'com.tmall.wireless': '天猫',
  'com.jingdong.app.mall': '京东',
  'com.xunmeng.pinduoduo': '拼多多',
  'com.sankuai.meituan': '美团',
  'com.sankuai.meituan.takeoutnew': '美团外卖',
  'com.dianping.v1': '大众点评',
  'com.ss.android.ugc.aweme': '抖音',
  'com.ss.android.article.news': '今日头条',
  'com.ss.android.lark': '飞书',
  'com.bytedance.lark': '飞书',
  'com.xingin.xhs': '小红书',
  'tv.danmaku.bili': '哔哩哔哩',
  'com.netease.cloudmusic': '网易云音乐',
  'com.netease.x19': '网易云游戏',
  'com.alibaba.android.rimet': '钉钉',
  'com.alibaba.wireless': '1688',
  'com.autonavi.minimap': '高德地图',
  'com.baidu.BaiduMap': '百度地图',
  'com.quark.browser': '夸克',
  'com.UCMobile': 'UC 浏览器',
  'com.zhihu.android': '知乎',
  'com.sina.weibo': '微博',
  'com.smile.gifmaker': '快手',
  'com.kuaishou.nebula': '快手极速版',
  'com.lemon.lv': '剪映',
  'cn.wps.moffice_eng': 'WPS Office',
  'com.microsoft.office.word': 'Word',
  'com.microsoft.rdc.androidx': '远程桌面',
  'com.dragon.read': '番茄小说',
  'com.achievo.vipshop': '唯品会',
  'com.unionpay': '云闪付',
  'com.icbc': '工商银行',
  'com.chinamworld.main': '建设银行',
  'com.tencent.tmgp.dfm': '三角洲行动',
};

const ICON_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#14b8a6',
  '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', '#ec4899',
];

function appLabel(packageName: string): string {
  const known = APP_NAMES[packageName];
  if (known) return known;
  const last = packageName.split('.').pop() ?? packageName;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

function iconColor(packageName: string): string {
  let hash = 0;
  for (let i = 0; i < packageName.length; i += 1) {
    hash = (hash * 31 + packageName.charCodeAt(i)) >>> 0;
  }
  return ICON_COLORS[hash % ICON_COLORS.length] ?? '#6366f1';
}

function iconText(packageName: string): string {
  return appLabel(packageName).charAt(0).toUpperCase();
}

async function loadApps(): Promise<void> {
  if (!props.deviceId) return;
  loading.value = true;
  try {
    const result = await api.listDeviceApps(props.deviceId, includeSystem.value);
    apps.value = [...result.packages].sort((a, b) =>
      appLabel(a.name).localeCompare(appLabel(b.name), 'zh-CN'),
    );
  } catch (error) {
    message.error(error instanceof Error ? error.message : '读取应用列表失败');
    apps.value = [];
  } finally {
    loading.value = false;
  }
}

function uninstall(packageName: string): void {
  dialog.error({
    title: '卸载应用',
    content: `确定从「${props.deviceName}」卸载 ${appLabel(packageName)} 吗？`,
    positiveText: '卸载',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.uninstallDeviceApp(props.deviceId, packageName);
        message.success('已卸载');
        await loadApps();
      } catch (error) {
        message.error(error instanceof Error ? error.message : '卸载失败');
      }
    },
  });
}

function exportApp(packageName: string): void {
  const link = document.createElement('a');
  link.href = api.deviceAppExportUrl(props.deviceId, packageName);
  link.download = `${packageName}.apk`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  message.success(`正在导出 ${packageName}.apk`);
}
</script>

<template>
  <n-drawer :show="show" :width="640" @update:show="emit('update:show', $event)">
    <n-drawer-content :title="title" closable>
      <div class="toolbar">
        <n-input
          v-model:value="keyword"
          size="small"
          clearable
          placeholder="搜索应用名或包名"
          class="search"
        />
        <n-button size="small" quaternary @click="loadApps">刷新</n-button>
        <label class="switch">
          <n-switch v-model:value="includeSystem" size="small" @update:value="loadApps" />
          <span>显示系统应用</span>
        </label>
        <span class="hint">{{ filtered.length }} / {{ apps.length }}</span>
      </div>

      <n-spin :show="loading">
        <div class="list">
          <n-empty
            v-if="filtered.length === 0 && !loading"
            description="没有读取到应用"
            class="empty"
          />
          <div v-for="pkg in filtered" :key="pkg.name" class="row">
            <div class="app-icon" :style="{ background: iconColor(pkg.name) }">
              {{ iconText(pkg.name) }}
            </div>
            <div class="info">
              <span class="name">{{ appLabel(pkg.name) }}</span>
              <span class="meta">
                {{ pkg.name }}<template v-if="pkg.version"> · v{{ pkg.version }}</template>
              </span>
            </div>
            <div class="actions">
              <n-button size="tiny" @click="exportApp(pkg.name)">导出</n-button>
              <n-button size="tiny" quaternary type="error" @click="uninstall(pkg.name)">
                卸载
              </n-button>
            </div>
          </div>
        </div>
      </n-spin>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.search {
  flex: 1;
  min-width: 0;
}

.hint {
  font-size: 11px;
  color: var(--text-faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
}

.switch {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-dim);
  cursor: pointer;
  white-space: nowrap;
}

.list {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.row:last-child {
  border-bottom: none;
}

.row:hover {
  background: var(--surface-2);
}

.app-icon {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  color: #ffffff;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.name {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  font-size: 10px;
  color: var(--text-faint);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  flex: none;
  display: flex;
  gap: 4px;
}

.empty {
  padding: 40px 0;
}
</style>