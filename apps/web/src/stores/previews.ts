import { ref } from 'vue';

export interface FloatingPreview {
  deviceId: string;
  deviceName: string;
  platform: 'android' | 'ios';
  sessionId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const previews = ref<FloatingPreview[]>([]);

const DEFAULT_WIDTH = 260;
const DEFAULT_HEIGHT = 470;
const MIN_WIDTH = 200;
const MIN_HEIGHT = 320;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function usePreviews() {
  /** 打开小窗；同一台设备只保留一个。 */
  function openPreview(input: {
    deviceId: string;
    deviceName: string;
    platform: 'android' | 'ios';
    sessionId: string;
  }): void {
    const existing = previews.value.find(
      (item) => item.deviceId === input.deviceId,
    );
    if (existing) {
      existing.sessionId = input.sessionId;
      existing.deviceName = input.deviceName;
      return;
    }

    const index = previews.value.length;
    const maxX = Math.max(8, window.innerWidth - DEFAULT_WIDTH - 16);
    const maxY = Math.max(8, window.innerHeight - DEFAULT_HEIGHT - 16);

    previews.value.push({
      ...input,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
      x: clamp(maxX - index * 16, 8, maxX),
      y: clamp(maxY - index * 16, 48, maxY),
    });
  }

  function closePreview(deviceId: string): void {
    previews.value = previews.value.filter(
      (item) => item.deviceId !== deviceId,
    );
  }

  function closeAllPreviews(): void {
    previews.value = [];
  }

  /** 点哪个窗口就把哪个提到最上层。 */
  function focusPreview(deviceId: string): void {
    const item = previews.value.find((entry) => entry.deviceId === deviceId);
    if (!item) return;
    previews.value = [
      ...previews.value.filter((entry) => entry.deviceId !== deviceId),
      item,
    ];
  }

  function updateRect(
    deviceId: string,
    rect: Partial<Pick<FloatingPreview, 'x' | 'y' | 'width' | 'height'>>,
  ): void {
    const item = previews.value.find((entry) => entry.deviceId === deviceId);
    if (!item) return;
    if (rect.x !== undefined) item.x = rect.x;
    if (rect.y !== undefined) item.y = rect.y;
    if (rect.width !== undefined) item.width = Math.max(MIN_WIDTH, rect.width);
    if (rect.height !== undefined) {
      item.height = Math.max(MIN_HEIGHT, rect.height);
    }
  }

  return {
    previews,
    openPreview,
    closePreview,
    closeAllPreviews,
    focusPreview,
    updateRect,
  };
}