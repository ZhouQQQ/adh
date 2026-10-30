/**
 * 投屏流的二进制帧格式。
 *
 *   [1 byte kind][payload...]
 *
 * 使用 WebSocket 二进制帧传输视频数据，避免 base64 带来的 33% 体积开销。
 * 文本帧（JSON）承载控制消息与元数据，因此这里只需要区分媒体类型。
 */
export const FRAME_KIND = {
  /** H.264 access unit（AVCC，长度前缀格式） */
  h264: 1,
  /** 完整 JPEG 图片（iOS WDA MJPEG） */
  jpeg: 2,
  /** UTF-8 JSON，作为二进制的补充元数据 */
  json: 3,
} as const;

export type FrameKind = (typeof FRAME_KIND)[keyof typeof FRAME_KIND];

const HEADER_BYTES = 1;

export function encodeFrame(kind: FrameKind, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + payload.byteLength);
  out[0] = kind;
  out.set(payload, HEADER_BYTES);
  return out;
}

export function decodeFrame(buffer: Uint8Array): {
  kind: FrameKind;
  payload: Uint8Array;
} {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error('frame too short');
  }
  return {
    kind: buffer[0] as FrameKind,
    payload: buffer.subarray(HEADER_BYTES),
  };
}

export function encodeJsonFrame(value: unknown): Uint8Array {
  return encodeFrame(
    FRAME_KIND.json,
    new TextEncoder().encode(JSON.stringify(value)),
  );
}