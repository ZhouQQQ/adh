import type { AgentSummary, DeviceStatus, Platform } from '@adh/protocol';

const STATUS_STYLES: Record<DeviceStatus, { label: string; className: string }> = {
  online: { label: '在线', className: 'bg-emerald-500/15 text-emerald-300' },
  offline: { label: '离线', className: 'bg-zinc-700/40 text-zinc-400' },
  unauthorized: {
    label: '未授权',
    className: 'bg-amber-500/15 text-amber-300',
  },
};

export function StatusPill({ status }: { status: DeviceStatus }) {
  const style = STATUS_STYLES[status]!;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${style.className}`}
    >
      <span
        className={`size-1.5 rounded-full ${
          status === 'online'
            ? 'bg-emerald-400'
            : status === 'unauthorized'
              ? 'bg-amber-400'
              : 'bg-zinc-500'
        }`}
      />
      {style.label}
    </span>
  );
}

export function PlatformBadge({ platform }: { platform: Platform }) {
  const isAndroid = platform === 'android';
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${
        isAndroid
          ? 'bg-green-500/15 text-green-300'
          : 'bg-sky-500/15 text-sky-300'
      }`}
    >
      {isAndroid ? 'ANDROID' : 'iOS'}
    </span>
  );
}

export function AgentOnlineDot({ agent }: { agent: AgentSummary }) {
  return (
    <span
      className={`size-2 rounded-full ${
        agent.online ? 'bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/60' : 'bg-zinc-600'
      }`}
    />
  );
}