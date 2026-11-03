const WDA_BASE = (process.env.ADH_WDA_URL ?? 'http://127.0.0.1:8100').replace(
  /\/+$/,
  '',
);

/**
 * 调整 WDA 内置 MJPEG 服务的帧率、JPEG 质量与缩放。
 * 直接改服务端参数比在转发时逐帧转码快得多。
 */
export async function wdaApplyMjpegSettings(input: {
  framerate: number;
  quality: number;
  scaling: number;
}): Promise<void> {
  try {
    await fetch(`${WDA_BASE}/appium/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        settings: {
          mjpegServerFramerate: input.framerate,
          mjpegServerScreenshotQuality: input.quality,
          mjpegServerScalingFactor: input.scaling,
        },
      }),
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    /* 旧版 WDA 不支持该设置时忽略，继续用默认参数 */
  }
}

let sessionId: string | null = null;
let sessionAt = 0;
let windowSize: { width: number; height: number } | null = null;
let windowSizeAt = 0;

const SESSION_TTL_MS = 5 * 60_000;
const WINDOW_TTL_MS = 60_000;

interface WdaResponse<T> {
  value: T;
  sessionId?: string;
}

async function request<T>(
  path: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<T> {
  const response = await fetch(`${WDA_BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init?.timeoutMs ?? 15_000),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const value = (parsed as { value?: { error?: string; message?: string } })?.value;
    throw new Error(value?.error ?? value?.message ?? `WDA ${response.status}`);
  }
  return ((parsed as WdaResponse<T>)?.value ?? null) as T;
}

async function createSession(): Promise<string> {
  const value = await request<{ sessionId?: string }>('/session', {
    method: 'POST',
    body: { capabilities: {} },
    timeoutMs: 20_000,
  });
  const id = value?.sessionId;
  if (!id) throw new Error('WDA 会话创建失败');
  sessionId = id;
  sessionAt = Date.now();
  return id;
}

async function ensureSession(): Promise<string> {
  if (sessionId && Date.now() - sessionAt < SESSION_TTL_MS) return sessionId;
  return createSession();
}

/** 会话失效时 WDA 会返回 unknown command / session does not exist，重试一次。 */
async function withSession<T>(task: (id: string) => Promise<T>): Promise<T> {
  const id = await ensureSession();
  try {
    return await task(id);
  } catch {
    sessionId = null;
    const retried = await createSession();
    return task(retried);
  }
}

export function wdaConfigured(): boolean {
  return Boolean(WDA_BASE);
}

/** WDA 截图，返回原始 PNG。 */
export async function wdaScreenshot(timeoutMs = 8_000): Promise<Buffer | null> {
  try {
    const response = await fetch(`${WDA_BASE}/screenshot`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { value?: unknown };
    if (typeof body.value !== 'string' || body.value.length === 0) return null;
    return Buffer.from(body.value, 'base64');
  } catch {
    return null;
  }
}

/** WDA 状态，包含设备 IP（iOS 拿不到 SSID，只能给 IP）。 */
export async function wdaStatus(): Promise<{ ip: string | null } | null> {
  try {
    const response = await fetch(`${WDA_BASE}/status`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      value?: { ios?: { ip?: unknown } };
    };
    const ip = body?.value?.ios?.ip;
    return { ip: typeof ip === 'string' ? ip : null };
  } catch {
    return null;
  }
}

export async function wdaWindow(): Promise<{ width: number; height: number }> {
  if (windowSize && Date.now() - windowSizeAt < WINDOW_TTL_MS) return windowSize;
  const value = await withSession((id) =>
    request<{ width: number; height: number }>(`/session/${id}/window/size`),
  );
  windowSize = { width: value.width, height: value.height };
  windowSizeAt = Date.now();
  return windowSize;
}

export async function wdaTap(x: number, y: number): Promise<void> {
  await withSession((id) =>
    request(`/session/${id}/wda/tap`, {
      method: 'POST',
      body: { x, y },
      timeoutMs: 10_000,
    }),
  );
}

export async function wdaSwipe(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  durationSeconds: number,
): Promise<void> {
  await withSession((id) =>
    request(`/session/${id}/wda/dragfromtoforduration`, {
      method: 'POST',
      body: {
        fromX,
        fromY,
        toX,
        toY,
        duration: Math.min(5, Math.max(0.1, durationSeconds)),
      },
      timeoutMs: 15_000,
    }),
  );
}

export type WdaButton = 'home' | 'volumeUp' | 'volumeDown';

export async function wdaPressButton(name: WdaButton): Promise<void> {
  await withSession((id) =>
    request(`/session/${id}/wda/pressButton`, {
      method: 'POST',
      body: { name },
      timeoutMs: 10_000,
    }),
  );
}

/** 从底部上滑并停顿，调出 iOS 多任务后台（App Switcher）。 */
export async function wdaAppSwitcher(): Promise<void> {
  const size = await wdaWindow();
  const x = Math.round(size.width / 2);
  await withSession((id) =>
    request(`/session/${id}/actions`, {
      method: 'POST',
      body: {
        actions: [
          {
            type: 'pointer',
            id: 'finger1',
            parameters: { pointerType: 'touch' },
            actions: [
              { type: 'pointerMove', duration: 0, x, y: size.height - 2 },
              { type: 'pointerDown', button: 0 },
              {
                type: 'pointerMove',
                duration: 120,
                x,
                y: size.height - 120,
              },
              {
                type: 'pointerMove',
                duration: 180,
                x,
                y: Math.round(size.height * 0.45),
              },
              { type: 'pause', duration: 700 },
              { type: 'pointerUp', button: 0 },
            ],
          },
        ],
      },
      timeoutMs: 20_000,
    }),
  );
}

export async function wdaTypeText(text: string): Promise<void> {
  if (!text) return;
  await withSession((id) =>
    request(`/session/${id}/wda/keys`, {
      method: 'POST',
      body: { value: [...text] },
      timeoutMs: 20_000,
    }),
  );
}