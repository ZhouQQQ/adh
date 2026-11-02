/** Document Picture-in-Picture：独立窗口，可拖到浏览器外面。 */

interface DocumentPictureInPictureApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  readonly window: Window | null;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPictureApi;
  }
}

export function supportsDocumentPip(): boolean {
  return Boolean(window.documentPictureInPicture?.requestWindow);
}

export interface DevicePipOptions {
  title: string;
  platform: 'android' | 'ios';
  stream: MediaStream;
  onTap: (x: number, y: number) => void;
  onSwipe: (
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    duration: number,
  ) => void;
  onKey: (key: 'back' | 'home' | 'recent') => void;
  onClose: () => void;
}

const STYLE = `
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #000; color: #e4e4e7;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  body { display: flex; flex-direction: column; }
  .title { flex: none; height: 26px; line-height: 26px; padding: 0 10px;
    font-size: 11px; color: #a1a1aa; background: #18181b; border-bottom: 1px solid #27272a;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stage { position: relative; flex: 1; min-height: 0; background: #000; overflow: hidden; touch-action: none; }
  video { display: block; width: 100%; height: 100%; object-fit: contain; background: #000; }
  .actions { flex: none; display: flex; height: 34px; border-top: 1px solid #27272a; background: #18181b; }
  .actions button { flex: 1; display: flex; align-items: center; justify-content: center; gap: 4px;
    border: none; background: transparent; color: #d4d4d8; font-size: 11px; cursor: pointer; }
  .actions button + button { border-left: 1px solid #27272a; }
  .actions button:hover { background: #27272a; color: #fafafa; }
  .actions button:disabled { opacity: .35; cursor: not-allowed; }
  .actions svg { width: 14px; height: 14px; flex: none; }
`;

export async function openDevicePip(
  options: DevicePipOptions,
): Promise<Window | null> {
  const api = window.documentPictureInPicture;
  if (!api) return null;

  const pipWindow = await api.requestWindow({ width: 300, height: 620 });
  const doc = pipWindow.document;

  doc.title = options.title;
  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.appendChild(style);

  doc.body.innerHTML = `
    <div class="title"></div>
    <div class="stage"><video autoplay muted playsinline></video></div>
    <div class="actions">
      <button data-key="back">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>
        <span>返回</span>
      </button>
      <button data-key="home">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/></svg>
        <span>主页</span>
      </button>
      <button data-key="recent">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="12" height="12" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2"/></svg>
        <span>任务</span>
      </button>
    </div>
  `;

  const title = doc.querySelector('.title');
  if (title) title.textContent = options.title;

  const video = doc.querySelector('video');
  if (!video) {
    pipWindow.close();
    return null;
  }
  video.srcObject = options.stream;
  void video.play().catch(() => undefined);

  const backButton = doc.querySelector<HTMLButtonElement>(
    'button[data-key="back"]',
  );
  if (backButton && options.platform === 'ios') backButton.disabled = true;

  doc.querySelectorAll<HTMLButtonElement>('button[data-key]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.key as 'back' | 'home' | 'recent';
      options.onKey(key);
    });
  });

  function contentPoint(event: PointerEvent): { x: number; y: number } | null {
    const rect = video!.getBoundingClientRect();
    const width = video!.videoWidth || 1;
    const height = video!.videoHeight || 1;
    const scale = Math.min(rect.width / width, rect.height / height);
    const drawWidth = width * scale;
    const drawHeight = height * scale;
    const offsetX = (rect.width - drawWidth) / 2;
    const offsetY = (rect.height - drawHeight) / 2;
    const x = (event.clientX - rect.left - offsetX) / drawWidth;
    const y = (event.clientY - rect.top - offsetY) / drawHeight;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  let start: { x: number; y: number; at: number } | null = null;

  video.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const point = contentPoint(event);
    if (!point) return;
    start = { ...point, at: Date.now() };
    video.setPointerCapture(event.pointerId);
  });

  video.addEventListener('pointerup', (event) => {
    if (!start) return;
    const from = start;
    start = null;
    const point = contentPoint(event) ?? { x: from.x, y: from.y };
    const distance = Math.hypot(point.x - from.x, point.y - from.y);
    if (distance < 0.02) {
      options.onTap(from.x, from.y);
    } else {
      options.onSwipe(
        from.x,
        from.y,
        point.x,
        point.y,
        Math.min(0.35, Math.max(0.12, (Date.now() - from.at) / 1000)),
      );
    }
  });

  video.addEventListener('contextmenu', (event) => event.preventDefault());

  pipWindow.addEventListener('pagehide', () => options.onClose());
  return pipWindow;
}