import type { ConnectionState } from '../useFleet';

const STYLES: Record<ConnectionState, { label: string; dot: string; className: string }> = {
  online: {
    label: '实时',
    dot: 'bg-emerald-400',
    className: 'text-emerald-300',
  },
  connecting: {
    label: '连接中',
    dot: 'bg-amber-400 animate-pulse',
    className: 'text-amber-300',
  },
  offline: {
    label: '已断开',
    dot: 'bg-red-400',
    className: 'text-red-300',
  },
};

export function ConnectionBadge({ state }: { state: ConnectionState }) {
  const style = STYLES[state]!;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${style.className}`}
    >
      <span className={`size-1.5 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right leading-tight">
      <div className="text-[10px] uppercase tracking-wide text-zinc-600">
        {label}
      </div>
      <div className="font-mono text-sm text-zinc-200">{value}</div>
    </div>
  );
}