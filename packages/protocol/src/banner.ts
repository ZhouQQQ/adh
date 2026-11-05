/**
 * 启动 banner：仿 Spring Boot 的 ASCII 标题 + 版本号。
 *
 * 只负责生成纯文本（可选 ANSI 颜色），不读写 process / stdout，
 * 这样 web 端也能安全地从 `@adh/protocol` 引用。
 */

const RESET = '\u001b[0m';
const GREEN = '\u001b[32m';
const BRIGHT_GREEN = '\u001b[92m';
const DIM = '\u001b[2m';

export type BannerName = 'adh-server' | 'adh-agent';

const ART: Record<BannerName, readonly string[]> = {
  'adh-server': [
    ' █████╗ ██████╗ ██╗  ██╗  ███████╗███████╗██████╗ ██╗   ██╗███████╗██████╗ ',
    '██╔══██╗██╔══██╗██║  ██║  ██╔════╝██╔════╝██╔══██╗██║   ██║██╔════╝██╔══██╗',
    '███████║██║  ██║███████║  ███████╗█████╗  ██████╔╝██║   ██║█████╗  ██████╔╝',
    '██╔══██║██║  ██║██╔══██║  ╚════██║██╔══╝  ██╔══██╗╚██╗ ██╔╝██╔══╝  ██╔══██╗',
    '██║  ██║██████╔╝██║  ██║  ███████║███████╗██║  ██║ ╚████╔╝ ███████╗██║  ██║',
    '╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝  ╚══════╝╚══════╝╚═╝  ╚═╝  ╚═══╝  ╚══════╝╚═╝  ╚═╝',
  ],
  'adh-agent': [
    ' █████╗ ██████╗ ██╗  ██╗   █████╗  ██████╗ ███████╗███╗   ██╗████████╗',
    '██╔══██╗██╔══██╗██║  ██║  ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝',
    '███████║██║  ██║███████║  ███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ',
    '██╔══██║██║  ██║██╔══██║  ██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ',
    '██║  ██║██████╔╝██║  ██║  ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ',
    '╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ',
  ],
};

export interface BannerOptions {
  /** 应用名，决定打印哪一段 ASCII 图形 */
  name: BannerName;
  /** 版本号，带不带 v 前缀都可以 */
  version: string;
  /** 版本行下方的附加信息，例如 Node 版本、平台、监听端口 */
  details?: string[];
  /** 终端支持 ANSI 时打开颜色（默认关闭） */
  color?: boolean;
}

/** 按字符数计算宽度；banner 内只有同字宽的 ASCII / box-drawing 字符。 */
function widthOf(line: string): number {
  return [...line].length;
}

function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${RESET}` : text;
}

/**
 * 生成 banner 文本，返回带换行的多行字符串（末尾不含多余空行）。
 */
export function renderBanner(options: BannerOptions): string {
  const art = ART[options.name];
  // Record 的索引访问在 noUncheckedIndexedAccess 下带 undefined，运行时必定存在
  if (!art) return '';
  const color = options.color === true;

  const width = Math.max(...art.map(widthOf));

  // 版本行左半部分固定，版本号右对齐到 ASCII 图形右边缘
  const label = `:: ${options.name} ::`;
  const normalized = options.version.replace(/^v(?=\d)/i, '');
  const version = `(v${normalized})`;
  const padding = Math.max(2, width + 2 - label.length - version.length);
  const footer = `  ${label}${' '.repeat(padding)}${version}`;

  const lines = [
    ...art.map((line) => paint(`  ${line}`, GREEN, color)),
    paint(footer, BRIGHT_GREEN, color),
  ];

  if (options.details && options.details.length > 0) {
    lines.push(paint(`  ${options.details.join(' · ')}`, DIM, color));
  }

  return lines.join('\n');
}