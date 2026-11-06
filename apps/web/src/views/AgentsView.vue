<script setup lang="ts">
import { computed, h, onMounted, onUnmounted, ref } from 'vue';
import {
  NButton,
  NDataTable,
  NDropdown,
  NIcon,
  NSpace,
  NTag,
  NText,
  useDialog,
  useMessage,
  type DataTableColumns,
  type DropdownOption,
} from 'naive-ui';
import {
  AddOutline,
  EllipsisHorizontalOutline,
  LogoApple,
  LogoTux,
  LogoWindows,
  RefreshOutline,
} from '@vicons/ionicons5';
import type { AgentSummary } from '@adh/protocol';
import AgentDetailDrawer from '../components/AgentDetailDrawer.vue';
import AgentDownloadButton from '../components/AgentDownloadButton.vue';
import AgentKeyModal from '../components/AgentKeyModal.vue';
import CreateAgentModal from '../components/CreateAgentModal.vue';
import EditAgentModal from '../components/EditAgentModal.vue';
import { api } from '../api';
import { useFleet } from '../stores/fleet';
import { formatAgo, formatDateTime } from '../utils/format';

const { agents, refresh } = useFleet();
const message = useMessage();
const dialog = useDialog();

const showCreate = ref(false);
const kindFilter = ref<'all' | 'host' | 'portal'>('all');
const keyShow = ref(false);
const keyName = ref('');
const keyValue = ref('');
const keyIsNew = ref(true);

const detailShow = ref(false);
const detailAgentId = ref<string | null>(null);

const editShow = ref(false);
const editingAgent = ref<AgentSummary | null>(null);

function openDetail(row: AgentSummary): void {
  detailAgentId.value = row.id;
  detailShow.value = true;
}

function openEdit(row: AgentSummary): void {
  editingAgent.value = row;
  editShow.value = true;
}

function onUpdated(): void {
  void refresh();
}

const now = ref(Date.now());
let timer: number | undefined;
onMounted(() => {
  timer = window.setInterval(() => (now.value = Date.now()), 10_000);
});
onUnmounted(() => {
  if (timer !== undefined) window.clearInterval(timer);
});

function openKeyModal(name: string, key: string, isNew: boolean): void {
  keyName.value = name;
  keyValue.value = key;
  keyIsNew.value = isNew;
  keyShow.value = true;
}

function onCreate(agent: AgentSummary, key: string): void {
  openKeyModal(agent.name, key, true);
  void refresh();
}

/** 节点宿主机系统：图标 + 名称，一眼分辨 Windows / macOS / Linux。 */
function osMeta(os?: string | null) {
  switch (os) {
    case 'windows':
      return { label: 'Windows', icon: LogoWindows };
    case 'darwin':
    case 'macos':
      return { label: 'macOS', icon: LogoApple };
    case 'linux':
      return { label: 'Linux', icon: LogoTux };
    default:
      return { label: '未知', icon: null };
  }
}

/** 状态标签：小圆点 + 文案，绿=在线/已连接，红=离线/失败。 */
const DOT = {
  online: '#22c55e',
  offline: '#ef4444',
  idle: '#9ca3af',
  pending: '#f0b429',
} as const;

function statusLabel(color: string, label: string) {
  return h(
    'span',
    { style: 'display:inline-flex;align-items:center;gap:5px' },
    [
      h('span', {
        style: `width:6px;height:6px;border-radius:50%;background:${color};flex:none`,
      }),
      label,
    ],
  );
}

const filteredAgents = computed(() =>
  kindFilter.value === 'all'
    ? agents.value
    : agents.value.filter((agent) => agent.kind === kindFilter.value),
);

const columns = computed<DataTableColumns<AgentSummary>>(() => [
  {
    title: '名称',
    key: 'name',
    minWidth: 150,
    render: (row) =>
      h(
        NSpace,
        { size: 6, align: 'center', wrap: false },
        {
          default: () => [
            h(NText, { strong: true }, { default: () => row.name }),
            row.builtin
              ? h(
                  NTag,
                  { size: 'tiny', type: 'info', bordered: false, round: true },
                  { default: () => '内置' },
                )
              : null,
            row.kind === 'portal'
              ? h(
                  NTag,
                  { size: 'tiny', type: 'success', bordered: false, round: true },
                  { default: () => '直连' },
                )
              : null,
          ],
        },
      ),
  },
  {
    title: '状态',
    key: 'status',
    width: 96,
    render: (row) => {
      const meta = row.online
        ? { type: 'success' as const, label: '在线', dot: DOT.online }
        : row.pending
          ? { type: 'warning' as const, label: '待接入', dot: DOT.pending }
          : { type: 'default' as const, label: '离线', dot: DOT.offline };
      return h(
        NTag,
        { size: 'small', type: meta.type, bordered: false, round: true },
        { default: () => statusLabel(meta.dot, meta.label) },
      );
    },
  },
  {
    title: '系统',
    key: 'os',
    width: 120,
    render: (row) => {
      if (!row.os) {
        return h('span', { style: 'color:var(--text-faint)' }, '尚未接入');
      }
      const meta = osMeta(row.os);
      return h(
        NSpace,
        { size: 6, align: 'center', wrap: false },
        {
          default: () => [
            meta.icon
              ? h(
                  NIcon,
                  { size: 16, color: 'var(--text-dim)' },
                  { default: () => h(meta.icon!) },
                )
              : null,
            h('span', null, meta.label),
          ],
        },
      );
    },
  },
  {
    title: '版本',
    key: 'version',
    width: 84,
    render: (row) => (row.version ? `v${row.version}` : '—'),
  },
  {
    title: '设备数',
    key: 'deviceCount',
    width: 78,
    align: 'right',
    // 离线节点的设备数是历史记录，不代表当前还连着，显示为 —
    render: (row) =>
      row.online || row.pending
        ? String(row.deviceCount)
        : h('span', { style: 'color:var(--text-faint)' }, '—'),
  },
  {
    title: 'iOS 隧道',
    key: 'tunnel',
    width: 104,
    render: (row) => {
      const tunnel = row.tunnel;
      // 待接入的节点还没有任何隧道记录
      if (row.pending) {
        return h('span', { style: 'color:var(--text-faint)' }, '—');
      }
      // 节点离线后隧道必然不可用，库里存的只是最后一次上报的快照
      if (!row.online) {
        const last = tunnel?.updatedAt
          ? formatDateTime(tunnel.updatedAt)
          : '无记录';
        return h(
          NTag,
          {
            size: 'small',
            type: 'default',
            bordered: false,
            round: true,
            title: `节点离线，隧道不可用 · 最后上报 ${last}`,
          },
          { default: () => statusLabel(DOT.offline, '离线') },
        );
      }
      if (!tunnel) {
        return h('span', { style: 'color:var(--text-faint)' }, '—');
      }
      if (tunnel.running) {
        const count = tunnel.tunnels.length;
        return h(
          NTag,
          { size: 'small', type: 'success', bordered: false, round: true },
          {
            default: () =>
              statusLabel(DOT.online, count > 0 ? `已连接 · ${count}` : '已连接'),
          },
        );
      }
      if (tunnel.error) {
        return h(
          NTag,
          {
            size: 'small',
            type: 'error',
            bordered: false,
            round: true,
            title: tunnel.error,
          },
          { default: () => statusLabel(DOT.offline, '启动失败') },
        );
      }
      return h(
        NTag,
        { size: 'small', type: 'default', bordered: false, round: true },
        { default: () => statusLabel(DOT.idle, '未启动') },
      );
    },
  },
  {
    title: 'Key',
    key: 'keyPreview',
    width: 190,
    render: (row) =>
      h(
        'code',
        { style: 'font-size:11px;color:var(--text-dim)' },
        row.keyPreview,
      ),
  },
  {
    title: '最后心跳',
    key: 'lastSeen',
    width: 110,
    render: (row) =>
      h(
        'span',
        { title: formatDateTime(row.lastSeen) },
        formatAgo(row.lastSeen, now.value),
      ),
  },
  {
    title: '操作',
    key: 'actions',
    width: 112,
    render: (row) => {
      const options = menuOptions(row);
      return h(
        NSpace,
        { size: 2, justify: 'end', align: 'center', wrap: false },
        {
          default: () => [
            h(
              NButton,
              { size: 'tiny', quaternary: true, onClick: () => openDetail(row) },
              { default: () => '详情' },
            ),
            options.length > 0
              ? h(
                  NDropdown,
                  {
                    trigger: 'click',
                    options,
                    onSelect: (key: string) => {
                      if (key === 'tunnel-start') void toggleTunnel(row, true);
                      else if (key === 'tunnel-stop')
                        void toggleTunnel(row, false);
                      else if (key === 'install-adb')
                        void installTools(row, 'android');
                      else if (key === 'install-goios')
                        void installTools(row, 'ios');
                      else if (key === 'edit') openEdit(row);
                      else if (key === 'rotate') void rotateKey(row);
                      else if (key === 'delete') confirmDelete(row);
                    },
                  },
                  {
                    default: () =>
                      h(
                        NButton,
                        { size: 'tiny', quaternary: true, circle: true },
                        {
                          icon: () =>
                            h(NIcon, { component: EllipsisHorizontalOutline }),
                        },
                      ),
                  },
                )
              : null,
          ],
        },
      );
    },
  },
]);

/** 节点操作菜单：依赖安装 + iOS 隧道开关 + 非内置节点的编辑 / Key / 删除。 */
function menuOptions(row: AgentSummary): DropdownOption[] {
  const options: DropdownOption[] = [];
  const canOperate = row.builtin || row.online;
  const platform = osMeta(row.os).label;

  // 缺什么才显示装什么；已装好的工具不重复展示
  if (canOperate) {
    if (!row.capabilities.includes('android')) {
      options.push({
        label: `安装 Android adb（${platform}）`,
        key: 'install-adb',
      });
    }
    if (!row.capabilities.includes('ios')) {
      options.push({
        label: `安装 iOS go-ios（${platform}）`,
        key: 'install-goios',
      });
    }
    if (options.length > 0) {
      options.push({ type: 'divider', key: 'divider-tools' });
    }
  }

  // 隧道是否可启动不再要求「已发现 iOS 设备」，没装 go-ios 时由接口给出明确错误
  options.push(
    {
      label: '启动 iOS 隧道',
      key: 'tunnel-start',
      disabled: !canOperate || Boolean(row.tunnel?.running),
    },
    {
      label: '停止 iOS 隧道',
      key: 'tunnel-stop',
      disabled:
        !canOperate || (!row.tunnel?.running && !row.tunnel?.error),
    },
    { type: 'divider', key: 'divider-tunnel' },
  );

  if (!row.builtin) {
    options.push(
      { label: '编辑名称', key: 'edit' },
      { label: '重置 Key', key: 'rotate' },
      { type: 'divider', key: 'divider' },
      { label: '删除', key: 'delete' },
    );
  }
  return options;
}

/** 在指定节点上安装 adb / go-ios，下载源由节点平台决定。 */
function installTools(row: AgentSummary, target: 'android' | 'ios'): void {
  const isAdb = target === 'android';
  const name = isAdb ? 'Android adb（Platform Tools）' : 'iOS go-ios';
  const platform = osMeta(row.os).label;
  dialog.warning({
    title: `安装 ${name}`,
    content: `将在「${row.name}」（${platform}）上下载并安装 ${name}。需要联网，通常 1~3 分钟，确定继续？`,
    positiveText: '安装',
    negativeText: '取消',
    onPositiveClick: async () => {
      const loading = message.loading(`正在安装 ${name}…`, { duration: 0 });
      try {
        const result = await api.installAgentTools(row.id, { [target]: true });
        message.success(
          result.capabilities.includes(target === 'android' ? 'android' : 'ios')
            ? `${name} 安装完成`
            : `${name} 安装完成，但未检测到可执行文件`,
        );
        await refresh();
      } catch (error) {
        message.error(error instanceof Error ? error.message : '安装失败');
      } finally {
        loading.destroy();
      }
    },
  });
}

async function toggleTunnel(
  row: AgentSummary,
  start: boolean,
): Promise<void> {
  const loading = message.loading(
    start ? '正在启动 iOS 隧道…' : '正在停止 iOS 隧道…',
    { duration: 0 },
  );
  try {
    await (start ? api.startAgentTunnel(row.id) : api.stopAgentTunnel(row.id));
    message.success(start ? 'iOS 隧道已启动' : 'iOS 隧道已停止');
    await refresh();
  } catch (error) {
    const text = error instanceof Error ? error.message : '';
    if (text.includes('go-ios')) {
      message.error('未找到 go-ios，请先在「节点操作」菜单安装 iOS go-ios');
    } else {
      message.error(text || (start ? '启动失败' : '停止失败'));
    }
  } finally {
    loading.destroy();
  }
}

async function rotateKey(row: AgentSummary): Promise<void> {
  dialog.warning({
    title: '重置接入 Key',
    content: `重置后「${row.name}」当前的连接会失效，需要用新 Key 重新接入。确定继续？`,
    positiveText: '重置',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const result = await api.rotateAgentKey(row.id);
        openKeyModal(result.agent.name, result.key, false);
        await refresh();
      } catch (error) {
        message.error(error instanceof Error ? error.message : '重置失败');
      }
    },
  });
}

function confirmDelete(row: AgentSummary): void {
  dialog.error({
    title: '删除节点',
    content: `确定删除「${row.name}」吗？其下 ${row.deviceCount} 台设备记录也会一并移除。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.deleteAgent(row.id);
        message.success('已删除');
        await refresh();
      } catch (error) {
        message.error(error instanceof Error ? error.message : '删除失败');
      }
    },
  });
}
</script>

<template>
  <div class="agents-page">
    <div class="toolbar">
      <p class="hint">
        节点部署在设备宿主机上，负责发现本机连接的 Android / iOS 设备并上报。
        新建后复制命令到宿主机执行即可接入。
      </p>
      <n-space>
        <n-select
          v-model:value="kindFilter"
          size="small"
          style="width: 132px"
          :options="[
            { label: '全部节点', value: 'all' },
            { label: '宿主机节点', value: 'host' },
            { label: '直连节点', value: 'portal' },
          ]"
        />
        <n-button quaternary size="small" @click="refresh">
          <template #icon>
            <n-icon :component="RefreshOutline" />
          </template>
        </n-button>
        <AgentDownloadButton size="small" />
        <n-button type="primary" size="small" @click="showCreate = true">
          <template #icon>
            <n-icon :component="AddOutline" />
          </template>
          新建节点
        </n-button>
      </n-space>
    </div>

    <n-data-table
      :columns="columns"
      :data="filteredAgents"
      :bordered="false"
      :single-line="false"
      :row-key="(row: AgentSummary) => row.id"
      size="small"
    />

    <CreateAgentModal v-model:show="showCreate" @created="onCreate" />
    <AgentKeyModal
      v-model:show="keyShow"
      :agent-name="keyName"
      :agent-key="keyValue"
      :is-new="keyIsNew"
    />
    <AgentDetailDrawer v-model:show="detailShow" :agent-id="detailAgentId" />
    <EditAgentModal
      v-model:show="editShow"
      :agent="editingAgent"
      @updated="onUpdated"
    />
  </div>
</template>

<style scoped>
.agents-page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-dim);
}

:deep(.n-data-table) {
  background: var(--surface);
  border-radius: 10px;
  border: 1px solid var(--border);
}
</style>


