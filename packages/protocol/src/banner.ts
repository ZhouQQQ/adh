/**
 * 启动 banner：仿 Spring Boot 的 ASCII 标题 + 版本号。
 *
 * 使用细线（figlet standard）字形，避免大块 █ 字符显得笨重。
 * 只负责生成纯文本（可选 ANSI 颜色），不读写 process / stdout，
 * 这样 web 端也能安全地从 `@adh/protocol` 引用。
 */

const RESET = '\u001b[0m';
/** 主题色 rgb(252, 200, 14)，加粗让细线字形更醒目 */
const THEME = '\u001b[1;38;2;252;200;14m';
const THEME_DIM = '\u001b[2;38;2;252;200;14m';

export type BannerName = 'adh-server' | 'adh-agent';

const ART: Record<BannerName, readonly string[]> = {
  'adh-server': [
    '    _     ____   _   _         ____   _____  ____  __     __ _____  ____',
    '   / \\   |  _ \\ | | | |       / ___| | ____||  _ \\ \\ \\   / /| ____||  _ \\',
    '  / _ \\  | | | || |_| | ----- \\___ \\ |  _|  | |_) | \\ \\ / / |  _|  | |_) |',
    ' / ___ \\ | |_| ||  _  |        ___) || |___ |  _ <   \\ V /  | |___ |  _ <',
    '/_/   \\_\\|____/ |_| |_|       |____/ |_____||_| \\_\\   \\_/   |_____||_| \\_\\',
  ],
  'adh-agent': [
    '    _     ____   _   _            _      ____  _____  _   _  _____',
    '   / \\   |  _ \\ | | | |          / \\    / ___|| ____|| \\ | ||_   _|',
    '  / _ \\  | | | || |_| | -----   / _ \\  | |  _ |  _|  |  \\| |  | |',
    ' / ___ \\ | |_| ||  _  |        / ___ \\ | |_| || |___ | |\\  |  | |',
    '/_/   \\_\\|____/ |_| |_|       /_/   \\_\\ \\____||_____||_| \\_|  |_|',
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

/** 按字符数计算宽度；banner 内只有同字宽的 ASCII 字符。 */
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
  const color = options.color === true;

  const indent = '  ';
  // 每行都补缩进，footer 的版本号右对齐到图形右边缘
  const width = Math.max(...art.map(widthOf)) + indent.length;

  const label = `:: ${options.name} ::`;
  const normalized = options.version.replace(/^v(?=\d)/i, '');
  const version = `(v${normalized})`;
  const padding = Math.max(2, width - label.length - version.length);
  const footer = `${indent}${label}${' '.repeat(padding)}${version}`;

  const lines = [
    ...art.map((line) => paint(`${indent}${line}`, THEME, color)),
    paint(footer, THEME, color),
  ];

  if (options.details && options.details.length > 0) {
    lines.push(paint(`${indent}${options.details.join(' · ')}`, THEME_DIM, color));
  }

  return lines.join('\n');
}