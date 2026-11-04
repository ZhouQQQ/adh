/**
 * WDA HTTP 封装。
 *
 * 一台宿主机可能接多台 iOS 设备，每台设备转发到不同的本地端口
 * （见 wdaPortFor），所以所有接口都要显式传端口。
 * 设置 ADH_WDA_URL 时退回到固定地址（兼容单设备 / 远端 WDA 的旧部署）。
 *
 * server 和 agent 共用这份实现：谁插着设备，就在谁的进程里调用。
 */

const REMOTE_BASE = process.env.ADH_WDA_URL?.replace(/\/+$/, '') ?? null;

function baseUrl(port: number): string {
  return REMOTE_BASE ?? `http://127.0.0.1:${port}`;
}

interface SessionEntry {
  id: string;
  at: number;
}

const sessions = new Map<number, SessionEntry>();
const windows = new Map<
  number,
  { size: { width: number; height: number }; at: number }
>();

const SESSION_TTL_MS = 5 * 60_000;
const WINDOW_TTL_MS = 60_000;

interface WdaResponse<T> {
  value: T;
  sessionId?: string;
}

async function request<T>(
  port: number,
  path: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<T> {
  const response = await fetch(`${baseUrl(port)}${path}`, {
    method: init?.method ?? 'GET',
    headers:
      init?.body === undefined
        ? undefined
        : { 'content-type': 'application/json' },
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
    const value = (parsed as { value?: { error?: string; message?: string } })
      ?.value;
    throw new Error(value?.error ?? value?.message ?? `WDA ${response.status}`);
  }
  return ((parsed as WdaResponse<T>)?.value ?? null) as T;
}

/**
 * 调整 WDA 内置 MJPEG 服务的帧率、JPEG 质量与缩放。
 * 直接改服务端参数比在转发时逐帧转码快得多。
 */
export async function wdaApplyMjpegSettings(
  port: number,
  input: {
    framerate: number;
    quality: number;
    scaling: number;
  },
): Promise<void> {
  try {
    await fetch(`${baseUrl(port)}/appium/settings`, {
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

/**
 * XCUITest 默认把设备当成连着硬件键盘，iOS 因此不弹软键盘，
 * 画面上只能看到输入辅助栏（截图底部那条「完成」）。
 */
async function applyKeyboardSettings(port: number): Promise<void> {
  try {
    await fetch(`${baseUrl(port)}/appium/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        settings: { connectHardwareKeyboard: false },
      }),
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    /* 旧版 WDA 不支持该设置时忽略 */
  }
}

async function createSession(port: number): Promise<string> {
  const value = await request<{ sessionId?: string }>(port, '/session', {
    method: 'POST',
    body: { capabilities: {} },
    timeoutMs: 20_000,
  });
  const id = value?.sessionId;
  if (!id) throw new Error('WDA 会话创建失败');
  sessions.set(port, { id, at: Date.now() });
  await applyKeyboardSettings(port);
  return id;
}

async function ensureSession(port: number): Promise<string> {
  const entry = sessions.get(port);
  if (entry && Date.now() - entry.at < SESSION_TTL_MS) return entry.id;
  return createSession(port);
}

/** 会话失效时 WDA 会返回 unknown command / session does not exist，重试一次。 */
async function withSession<T>(
  port: number,
  task: (id: string) => Promise<T>,
): Promise<T> {
  const id = await ensureSession(port);
  try {
    return await task(id);
  } catch {
    sessions.delete(port);
    const retried = await createSession(port);
    return task(retried);
  }
}

/** 锁屏（模拟电源键）。 */
export async function wdaLock(port: number): Promise<void> {
  await withSession(port, (id) =>
    request(port, `/session/${id}/wda/lock`, {
      method: 'POST',
      timeoutMs: 5_000,
    }),
  );
}

/** 唤醒屏幕。 */
export async function wdaUnlock(port: number): Promise<void> {
  await withSession(port, (id) =>
    request(port, `/session/${id}/wda/unlock`, {
      method: 'POST',
      timeoutMs: 5_000,
    }),
  );
}

/** WDA 截图，返回原始 PNG。 */
export async function wdaScreenshot(
  port: number,
  timeoutMs = 8_000,
): Promise<Buffer | null> {
  try {
    const response = await fetch(`${baseUrl(port)}/screenshot`, {
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
export async function wdaStatus(
  port: number,
): Promise<{ ip: string | null } | null> {
  try {
    const response = await fetch(`${baseUrl(port)}/status`, {
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

export async function wdaWindow(
  port: number,
): Promise<{ width: number; height: number }> {
  const cached = windows.get(port);
  if (cached && Date.now() - cached.at < WINDOW_TTL_MS) return cached.size;
  const value = await withSession(port, (id) =>
    request<{ width: number; height: number }>(
      port,
      `/session/${id}/window/size`,
    ),
  );
  const size = { width: value.width, height: value.height };
  windows.set(port, { size, at: Date.now() });
  return size;
}

export async function wdaTap(
  port: number,
  x: number,
  y: number,
): Promise<void> {
  await withSession(port, (id) =>
    request(port, `/session/${id}/wda/tap`, {
      method: 'POST',
      body: { x, y },
      timeoutMs: 10_000,
    }),
  );
}

export async function wdaSwipe(
  port: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  durationSeconds: number,
): Promise<void> {
  await withSession(port, (id) =>
    request(port, `/session/${id}/wda/dragfromtoforduration`, {
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

/**
 * 双指缩放：使用 WDA 原生 pinch。
 * scale > 1 放大，< 1 缩小；velocity 为每秒缩放倍率。
 */
export async function wdaPinch(
  port: number,
  scale: number,
  velocity = 1,
): Promise<void> {
  await withSession(port, (id) =>
    request(port, `/session/${id}/wda/pinch`, {
      method: 'POST',
      body: {
        scale: Math.min(10, Math.max(0.1, scale)),
        velocity: Math.min(10, Math.max(0.1, velocity)),
      },
      timeoutMs: 20_000,
    }),
  );
}

export type WdaButton = 'home' | 'volumeUp' | 'volumeDown';

export async function wdaPressButton(
  port: number,
  name: WdaButton,
): Promise<void> {
  await withSession(port, (id) =>
    request(port, `/session/${id}/wda/pressButton`, {
      method: 'POST',
      body: { name },
      timeoutMs: 10_000,
    }),
  );
}

/** 从底部上滑并停顿，调出 iOS 多任务后台（App Switcher）。 */
export async function wdaAppSwitcher(port: number): Promise<void> {
  const size = await wdaWindow(port);
  const x = Math.round(size.width / 2);
  await withSession(port, (id) =>
    request(port, `/session/${id}/actions`, {
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

export async function wdaTypeText(port: number, text: string): Promise<void> {
  if (!text) return;
  await withSession(port, (id) =>
    request(port, `/session/${id}/wda/keys`, {
      method: 'POST',
      body: { value: [...text] },
      timeoutMs: 20_000,
    }),
  );
}
