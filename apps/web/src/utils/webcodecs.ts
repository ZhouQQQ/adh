/**
 * 安卓投屏用 WebCodecs 解码 H.264。
 *
 * WebCodecs 只在安全上下文（https / localhost / 127.0.0.1）暴露：
 * 用局域网 IP + http 打开时 `VideoDecoder` 根本不存在，
 * 直接 new 会抛 ReferenceError，画面就一直停在「正在连接设备…」。
 */
export function isWebCodecsAvailable(): boolean {
  return typeof VideoDecoder === 'function';
}

export const WEB_CODECS_TITLE = '当前浏览器无法解码安卓投屏';

export function webCodecsReason(): string {
  if (!window.isSecureContext) {
    return `当前页面是 ${window.location.origin}，属于非安全上下文，浏览器禁用了视频解码（WebCodecs）。`;
  }
  return '当前浏览器不支持 WebCodecs 视频解码。';
}

export function webCodecsHints(): string[] {
  if (window.isSecureContext) {
    return ['请升级到最新版 Chrome / Edge / Safari 后再试。'];
  }
  return [
    '改用 http://localhost:5173 打开本页面（需要在本机操作）。',
    '或给站点配置 HTTPS 后访问。',
    'Chrome 也可以在 chrome://flags/#unsafely-treat-insecure-origin-as-secure 把本地址加入白名单。',
  ];
}
