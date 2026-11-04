/**
 * 构建时注入的版本信息（见 vite.config.ts 的 define）。
 * dev 模式下构建时间是 Vite 启动时间，生产构建是打包时刻。
 */
export const APP_VERSION = `v${__ADH_VERSION__}`;

export function formatBuildTime(raw: string): string {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const BUILD_TIME = formatBuildTime(__ADH_BUILD_TIME__);
