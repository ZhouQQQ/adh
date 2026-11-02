/** 实时预览画质档位：默认 low，优先保证速度和帧率。 */
export type StreamQuality = 'low' | 'medium' | 'high';

export interface StreamQualityPreset {
  /** scrcpy 长边像素上限 */
  maxSize: number;
  /** scrcpy 码率 */
  bitrate: number;
  /** iOS MJPEG / 截图缩放后的宽度 */
  iosWidth: number;
  /** iOS JPEG 质量 */
  iosQuality: number;
}

export const STREAM_QUALITY_PRESETS: Record<StreamQuality, StreamQualityPreset> = {
  low: { maxSize: 720, bitrate: 2_000_000, iosWidth: 360, iosQuality: 40 },
  medium: { maxSize: 1080, bitrate: 4_000_000, iosWidth: 540, iosQuality: 55 },
  high: { maxSize: 1440, bitrate: 8_000_000, iosWidth: 0, iosQuality: 100 },
};

export function normalizeQuality(value?: string | null): StreamQuality {
  return value === 'low' || value === 'high' ? value : 'medium';
}

export function resolveQuality(value?: string | null): {
  quality: StreamQuality;
  preset: StreamQualityPreset;
} {
  const quality = normalizeQuality(value);
  return { quality, preset: STREAM_QUALITY_PRESETS[quality] };
}