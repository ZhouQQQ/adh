<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { NSpin, NTag, useMessage } from 'naive-ui';
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

const actionLabels: Record<string, string> = {
  'control.start': '开始控制',
  'control.view': '观看投屏',
  'control.takeover': '接管控制',
  'control.stop': '断开投屏',
  'control.kick': '强制断开',
  'control.viewers': '查看权限',
  'device.lock': '锁定设备',
  'device.unlock': '解除锁定',
  'app.install': '安装应用',
  'app.uninstall': '卸载应用',
  'file.upload': '上传文件',
  'file.download': '下载文件',
  'file.delete': '删除文件',
};
</script>

<template>
  <div class="dashboard">
    <n-spin :show="loading">
      <template v-if="data">
        <div class="cards">
          <div class="card">
            <div class="card-label">用户</div>
            <div class="card-value">{{ data.users.total }}</div>
            <div class="card-hint">
              管理员 {{ data.users.admins }} · 启用 {{ data.users.enabled }}
            </div>
          </div>
          <div class="card">
            <div class="card-label">设备</div>
            <div class="card-value">{{ data.devices.total }}</div>
            <div class="card-hint">
              在线 {{ data.devices.online }} · 占用 {{ data.devices.inUse }} · 锁定
              {{ data.devices.locked }}
            </div>
          </div>
          <div class="card">
            <div class="card-label">今日使用</div>
            <div class="card-value">{{ formatDuration(data.usage.todaySeconds) }}</div>
            <div class="card-hint">
              {{ data.usage.todaySessions }} 次控制 · {{ data.usage.todayUsers }} 人参与
            </div>
          </div>
          <div class="card">
            <div class="card-label">近 {{ data.usage.windowDays }} 天使用时长</div>
            <div class="card-value">{{ formatDuration(data.usage.seconds) }}</div>
            <div class="card-hint">{{ data.usage.sessions }} 次控制会话</div>
          </div>
        </div>

        <div class="cards small">
          <div class="card">
            <div class="card-label">设备在线率</div>
            <div class="card-value">{{ onlineRate }}%</div>
            <div class="card-hint">
              离线 {{ data.devices.offline }} · 未授权 {{ data.devices.unauthorized }}
            </div>
          </div>
          <div class="card">
            <div class="card-label">节点</div>
            <div class="card-value">{{ data.agents.online }}/{{ data.agents.total }}</div>
            <div class="card-hint">在线 / 全部</div>
          </div>
          <div class="card">
            <div class="card-label">安装包</div>
            <div class="card-value">{{ data.packages.total }}</div>
            <div class="card-hint">
              APK {{ data.packages.apk }} · IPA {{ data.packages.ipa }} ·
              {{ formatSize(data.packages.totalSize) }}
            </div>
          </div>
          <div class="card">
            <div class="card-label">设备平均年龄</div>
            <div class="card-value">{{ formatAge(data.devices.avgAgeDays) }}</div>
            <div class="card-hint">
              依据 {{ data.devices.publishedCount }} 台已填发布时间的设备
            </div>
          </div>
          <div class="card">
            <div class="card-label">今日活跃用户</div>
            <div class="card-value">{{ data.usage.todayUsers }}</div>
            <div class="card-hint">按控制次数去重</div>
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
                  />
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
              <span class="recent-user">{{ item.username || '—' }}</span>
              <span class="recent-device">{{ item.deviceName || '—' }}</span>
              <n-tag size="tiny" :bordered="false">
                {{ actionLabels[item.action] ?? item.action }}
              </n-tag>
            </div>
          </div>
        </section>
      </template>
    </n-spin>
  </div>
</template>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 1180px;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

.card {
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}

.card-label {
  font-size: 12px;
  color: var(--text-dim);
}

.card-value {
  margin: 6px 0 4px;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

.card-hint {
  font-size: 11px;
  color: var(--text-faint);
}

.panels {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
}

.panel {
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}

.panel-title {
  margin-bottom: 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
}

.chart {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  height: 150px;
}

.bar-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.bar-track {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
  background: var(--surface-2);
  border-radius: 5px;
  overflow: hidden;
}

.bar-fill {
  width: 100%;
  border-radius: 5px 5px 0 0;
  background: linear-gradient(180deg, #60a5fa 0%, #3b82f6 100%);
  transition: height 0.3s ease;
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
  grid-template-columns: 80px 110px 1fr auto;
  gap: 10px;
  align-items: center;
  padding: 7px 0;
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