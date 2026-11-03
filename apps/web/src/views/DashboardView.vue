<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { NIcon, NSpin, NTag, useMessage } from 'naive-ui';
import {
  ArchiveOutline,
  CalendarOutline,
  PeopleOutline,
  PhonePortraitOutline,
  PulseOutline,
  TimeOutline,
  TimerOutline,
} from '@vicons/ionicons5';
import { api, type DashboardData } from '../api';

const message = useMessage();
const data = ref<DashboardData | null>(null);
const loading = ref(true);

let timer: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<void> {
  try {
    data.value = await api.getDashboard();
  } catch (error) {
    message.error(error instanceof Error ? error.message : '读取仪表盘失败');
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 30_000);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  timer = null;
});

/** 秒数转成「X 小时 X 分钟」。 */
function formatDuration(seconds: number): string {
  if (seconds <= 0) return '—';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days} 天 ${hours % 24} 小时`;
  }
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${seconds} 秒`;
}

/** 卡片上的时长用紧凑写法，避免一行放不下。 */
function compactDuration(seconds: number): string {
  if (seconds <= 0) return '0';
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} 小时`;
  return `${(seconds / 86_400).toFixed(1)} 天`;
}

/** 柱状图里用的超短时长写法。 */
function barLabel(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  if (seconds > 0) return `${seconds}s`;
  return '';
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 设备平均年龄：按天换算成月 / 年。 */
function formatAge(days: number | null): string {
  if (days === null) return '—';
  if (days < 30) return `${days} 天`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} 个月`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest > 0 ? `${years} 年 ${rest} 个月` : `${years} 年`;
}

function clock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
}

const dailyMax = computed(() => {
  const values = data.value?.daily.map((item) => item.seconds) ?? [];
  return Math.max(1, ...values);
});

const onlineRate = computed(() => {
  const devices = data.value?.devices;
  if (!devices || devices.total === 0) return 0;
  return Math.round((devices.online / devices.total) * 100);
});

/** 顶部指标卡：数值、说明、图标和配色。 */
const cards = computed(() => {
  const d = data.value;
  if (!d) return [];
  return [
    {
      key: 'users',
      label: '总用户',
      value: String(d.users.total),
      hint: `近一周活跃 ${d.usage.weekUsers} · 近 30 天活跃 ${d.usage.monthUsers}`,
      icon: PeopleOutline,
      tone: 'blue',
    },
    {
      key: 'devices',
      label: '设备',
      value: String(d.devices.total),
      hint: `在线 ${d.devices.online} · 占用 ${d.devices.inUse} · 锁定 ${d.devices.locked}`,
      icon: PhonePortraitOutline,
      tone: 'emerald',
    },
    {
      key: 'today',
      label: '今日',
      value: compactDuration(d.usage.todaySeconds),
      hint: `${d.usage.todaySessions} 次控制 · ${d.usage.todayUsers} 人`,
      icon: TimeOutline,
      tone: 'amber',
    },
    {
      key: 'usage',
      label: `近 ${d.usage.windowDays} 天使用`,
      value: compactDuration(d.usage.seconds),
      hint: `${d.usage.sessions} 次控制会话`,
      icon: TimerOutline,
      tone: 'violet',
    },
    {
      key: 'rate',
      label: '设备在线率',
      value: `${onlineRate.value}%`,
      hint: `离线 ${d.devices.offline} · 未授权 ${d.devices.unauthorized}`,
      icon: PulseOutline,
      tone: 'cyan',
    },
    {
      key: 'age',
      label: '设备平均年龄',
      value: formatAge(d.devices.avgAgeDays),
      hint: `依据 ${d.devices.publishedCount} 台已填发布时间的设备`,
      icon: CalendarOutline,
      tone: 'orange',
    },
    {
      key: 'packages',
      label: '安装包',
      value: String(d.packages.total),
      hint: `APK ${d.packages.apk} · IPA ${d.packages.ipa} · ${formatSize(d.packages.totalSize)}`,
      icon: ArchiveOutline,
      tone: 'rose',
    },
  ];
});

const actionLabels: Record<string, string> = {
  'control.start': '开始控制',
  'control.view': '观看投屏',
  'control.takeover': '接管控制',
  'control.stop': '断开投屏',
  'control.kick': '强制断开',
  'control.viewers': '查看权限',
  'device.lock': '锁定设备',
  'device.unlock': '解除锁定',
  'input.touch': '触摸操作',
  'input.key': '按键',
  'input.text': '文本输入',
  'input.rotate': '旋转屏幕',
  'input.screen': '亮屏 / 息屏',
  'input.panel': '通知栏',
  'app.install': '安装应用',
  'app.uninstall': '卸载应用',
  'file.upload': '上传文件',
  'file.download': '下载文件',
  'file.delete': '删除文件',
  'file.rename': '重命名文件',
  'file.copy': '复制文件',
  'file.move': '移动文件',
};

function userText(item: DashboardData['recent'][number]): string {
  if (!item.username) return '—';
  return item.displayName
    ? `${item.username}（${item.displayName}）`
    : item.username;
}
</script>

<template>
  <div class="dashboard">
    <n-spin :show="loading">
      <div class="dashboard-body">
        <template v-if="data">
        <div class="cards">
          <div
            v-for="card in cards"
            :key="card.key"
            class="card"
            :class="card.tone"
          >
            <span class="card-icon">
              <n-icon :size="16"><component :is="card.icon" /></n-icon>
            </span>
            <div class="card-body">
              <div class="card-label">{{ card.label }}</div>
              <div class="card-value">{{ card.value }}</div>
              <div class="card-hint" v-if="card.hint">{{ card.hint }}</div>
            </div>
          </div>
        </div>

        <div class="panels">
          <section class="panel">
            <div class="panel-title">近 7 天使用时长</div>
            <div class="chart">
              <div
                v-for="item in data.daily"
                :key="item.date"
                class="bar-col"
                :title="`${item.date} · ${item.sessions} 次 · ${formatDuration(item.seconds)}`"
              >
                <div class="bar-track">
                  <div
                    class="bar-fill"
                    :style="{ height: `${Math.max(2, (item.seconds / dailyMax) * 100)}%` }"
                  >
                    <span v-if="item.seconds > 0" class="bar-value">
                      {{ barLabel(item.seconds) }}
                    </span>
                  </div>
                </div>
                <div class="bar-label">{{ item.date.slice(5) }}</div>
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-title">设备使用排行</div>
            <div v-if="data.deviceRanking.length === 0" class="empty">
              还没有控制记录
            </div>
            <ol v-else class="rank">
              <li v-for="(item, index) in data.deviceRanking" :key="item.deviceId">
                <span class="rank-no">{{ index + 1 }}</span>
                <div class="rank-main">
                  <span class="rank-name" :title="item.deviceName">
                    {{ item.deviceName }}
                  </span>
                  <span class="rank-hint">
                    {{ item.sessions }} 次 · {{ formatDuration(item.seconds) }}
                  </span>
                </div>
                <div class="rank-bar">
                  <div
                    class="rank-fill"
                    :style="{
                      width: `${Math.max(4, (item.seconds / Math.max(1, data.deviceRanking[0].seconds)) * 100)}%`,
                    }"
                  />
                </div>
              </li>
            </ol>
          </section>

          <section class="panel">
            <div class="panel-title">用户使用排行</div>
            <div v-if="data.userRanking.length === 0" class="empty">
              还没有用户控制记录
            </div>
            <ol v-else class="rank">
              <li v-for="(item, index) in data.userRanking" :key="item.username">
                <span class="rank-no">{{ index + 1 }}</span>
                <div class="rank-main">
                  <span class="rank-name">
                    {{ item.displayName || item.username }}
                  </span>
                  <span class="rank-hint">
                    {{ item.sessions }} 次 · {{ formatDuration(item.seconds) }}
                  </span>
                </div>
                <div class="rank-bar">
                  <div
                    class="rank-fill user"
                    :style="{
                      width: `${Math.max(4, (item.seconds / Math.max(1, data.userRanking[0].seconds)) * 100)}%`,
                    }"
                  />
                </div>
              </li>
            </ol>
          </section>
        </div>

        <section class="panel">
          <div class="panel-title">最近动态</div>
          <div v-if="data.recent.length === 0" class="empty">暂无操作记录</div>
          <div v-else class="recent">
            <div v-for="(item, index) in data.recent" :key="index" class="recent-row">
              <span class="recent-time">{{ clock(item.createdAt) }}</span>
              <span class="recent-user" :title="userText(item)">{{ userText(item) }}</span>
              <span class="recent-device">{{ item.deviceName || '—' }}</span>
              <n-tag size="tiny" :bordered="false">
                {{ actionLabels[item.action] ?? item.action }}
              </n-tag>
            </div>
          </div>
        </section>
        </template>
      </div>
    </n-spin>
  </div>
</template>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding-right: 10px;
}

/* n-spin 会包一层容器，间距要放在内层，否则卡片和面板会贴在一起 */
.dashboard-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 14px;
}

.card {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: linear-gradient(180deg, #ffffff 0%, #fafafa 100%);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.card:hover {
  border-color: var(--border-strong);
  box-shadow: 0 4px 14px rgba(9, 9, 11, 0.06);
}

.card-icon {
  flex: none;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: #f4f4f5;
  color: #71717a;
}

.card-body {
  flex: 1;
  min-width: 0;
}

.card-label {
  font-size: 12px;
  color: var(--text-dim);
}

.card-value {
  margin: 6px 0 4px;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.02em;
  overflow-wrap: anywhere;
}

.card-hint {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-faint);
  overflow-wrap: anywhere;
}

.panels {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 14px;
}

.panel {
  display: flex;
  flex-direction: column;
  padding: 18px 20px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}

.panel-title {
  margin-bottom: 14px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
}

.chart {
  display: flex;
  align-items: stretch;
  gap: 8px;
  flex: 1;
  min-height: 140px;
}

.bar-col {
  flex: 1;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.bar-track {
  flex: 1;
  width: 100%;
  min-height: 0;
  display: flex;
  align-items: flex-end;
  background: var(--surface-2);
  border-radius: 5px;
  overflow: hidden;
}

.bar-fill {
  width: 100%;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 4px;
  border-radius: 5px 5px 0 0;
  background: linear-gradient(180deg, #60a5fa 0%, #3b82f6 100%);
  transition: height 0.3s ease;
}

.bar-value {
  font-size: 10px;
  font-weight: 600;
  color: #ffffff;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.bar-label {
  font-size: 10px;
  color: var(--text-faint);
  white-space: nowrap;
}

.rank {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.rank li {
  display: grid;
  grid-template-columns: 20px 1fr;
  gap: 4px 8px;
  align-items: center;
}

.rank-no {
  font-size: 11px;
  color: var(--text-faint);
  text-align: right;
}

.rank-main {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.rank-name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rank-hint {
  flex: none;
  font-size: 10px;
  color: var(--text-faint);
}

.rank-bar {
  grid-column: 2;
  height: 4px;
  border-radius: 2px;
  background: var(--surface-2);
  overflow: hidden;
}

.rank-fill {
  height: 100%;
  border-radius: 2px;
  background: #3b82f6;
}

.rank-fill.user {
  background: #8b5cf6;
}

.recent {
  display: flex;
  flex-direction: column;
}

.recent-row {
  display: grid;
  grid-template-columns: 80px 160px 1fr auto;
  gap: 12px;
  align-items: center;
  padding: 9px 0;
  border-top: 1px solid var(--border);
  font-size: 12px;
}

.recent-row:first-child {
  border-top: none;
}

.recent-time {
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

.recent-user {
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-device {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  padding: 18px 0;
  font-size: 12px;
  color: var(--text-faint);
  text-align: center;
}
</style>