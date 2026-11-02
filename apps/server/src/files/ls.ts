export interface RemoteFileEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: string;
}

/** toybox `ls -la` 的一行：drwxrws--- 2 u0_a0 media_rw 3452 2026-11-01 13:49 Android */
const LS_LINE =
  /^([dl-])[rwxsStT-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/;

export function parseLsOutput(raw: string): RemoteFileEntry[] {
  const entries: RemoteFileEntry[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const text = line.trimEnd();
    if (!text || text.startsWith('total ')) continue;

    const match = LS_LINE.exec(text);
    if (!match) continue;

    const [, type, size, date, time, name] = match;
    if (!name || name === '.' || name === '..') continue;

    entries.push({
      name,
      isDir: type === 'd',
      size: Number(size),
      mtime: `${date} ${time}`,
    });
  }

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  return entries;
}

/** 规范化设备路径，拒绝 .. 穿越。 */
export function normalizeDevicePath(input: string): string {
  const raw = (input || '/storage/emulated/0').trim();
  const parts = raw.split('/').filter((part) => part && part !== '.');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return `/${stack.join('/')}`;
}

export function baseName(devicePath: string): string {
  const index = devicePath.lastIndexOf('/');
  return index >= 0 ? devicePath.slice(index + 1) : devicePath;
}