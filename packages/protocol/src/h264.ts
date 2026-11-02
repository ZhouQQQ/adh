/**
 * H.264 Annex-B 工具集。
 *
 * 纯 Uint8Array 实现，server / agent / 浏览器三端共用：
 * - 从连续字节流里切分 access unit（一帧）
 * - 生成 WebCodecs 需要的 avcC description
 * - 把 Annex-B 转成 AVCC（4 字节长度前缀）
 */

export interface H264AccessUnit {
  /** Annex-B 格式，含起始码 */
  data: Uint8Array;
  key: boolean;
}

export interface H264Config {
  /** 去掉起始码的 SPS NAL */
  sps: Uint8Array;
  /** 去掉起始码的 PPS NAL */
  pps: Uint8Array;
  /** avcC description */
  description: Uint8Array;
  /** WebCodecs codec 字符串，例如 avc1.640028 */
  codec: string;
}

interface StartCode {
  index: number;
  length: number;
}

function findStartCode(buffer: Uint8Array, from: number): StartCode | null {
  for (let i = from; i + 3 < buffer.length; i += 1) {
    if (buffer[i] !== 0 || buffer[i + 1] !== 0) continue;
    if (buffer[i + 2] === 1) return { index: i, length: 3 };
    if (buffer[i + 2] === 0 && buffer[i + 3] === 1) {
      return { index: i, length: 4 };
    }
  }
  return null;
}

export function stripStartCode(nal: Uint8Array): Uint8Array {
  if (nal.length >= 4 && nal[0] === 0 && nal[1] === 0 && nal[2] === 0 && nal[3] === 1) {
    return nal.subarray(4);
  }
  if (nal.length >= 3 && nal[0] === 0 && nal[1] === 0 && nal[2] === 1) {
    return nal.subarray(3);
  }
  return nal;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const chunk of chunks) size += chunk.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function nalTypeOf(nal: Uint8Array): number {
  const body = stripStartCode(nal);
  return body.length > 0 ? (body[0] as number) & 0x1f : 0;
}

const NAL_SLICE = 1;
const NAL_IDR = 5;
const NAL_SPS = 7;
const NAL_PPS = 8;

/** 增量解析器：喂任意大小的 chunk，回调完整的一帧。 */
export class H264AccessUnitParser {
  private buffer: Uint8Array = new Uint8Array(0);
  private pending: Uint8Array[] = [];
  private pendingHasVcl = false;
  private pendingKey = false;
  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;

  constructor(private readonly onAccessUnit: (unit: H264AccessUnit) => void) {}

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.buffer =
      this.buffer.length === 0 ? chunk.slice() : concat([this.buffer, chunk]);

    let offset = 0;
    for (;;) {
      const start = findStartCode(this.buffer, offset);
      if (!start) break;
      const next = findStartCode(this.buffer, start.index + start.length);
      if (!next) break;

      const nal = this.buffer.subarray(start.index, next.index);
      this.handleNal(nal);
      offset = next.index;
    }

    if (offset > 0) this.buffer = this.buffer.subarray(offset);
  }

  /** 流结束时把残留的一帧吐出去。 */
  flush(): void {
    this.emitPending();
  }

  getConfig(): H264Config | null {
    if (!this.sps || !this.pps) return null;
    const description = buildAvcC(this.sps, this.pps);
    if (!description) return null;
    return {
      sps: this.sps,
      pps: this.pps,
      description,
      codec: codecString(this.sps),
    };
  }

  private handleNal(nal: Uint8Array): void {
    const type = nalTypeOf(nal);

    if (type === NAL_SPS) {
      if (this.pendingHasVcl) this.emitPending();
      this.sps = stripStartCode(nal).slice();
      this.pending.push(nal);
      return;
    }
    if (type === NAL_PPS) {
      this.pps = stripStartCode(nal).slice();
      this.pending.push(nal);
      return;
    }

    if (type === NAL_SLICE || type === NAL_IDR) {
      if (this.pendingHasVcl) this.emitPending();
      this.pending.push(nal);
      this.pendingHasVcl = true;
      if (type === NAL_IDR) this.pendingKey = true;
      return;
    }

    // SEI 等非 VCL 数据，跟随当前帧
    this.pending.push(nal);
  }

  private emitPending(): void {
    if (this.pending.length > 0 && this.pendingHasVcl) {
      this.onAccessUnit({
        data: concat(this.pending),
        key: this.pendingKey,
      });
    }
    this.pending = [];
    this.pendingHasVcl = false;
    this.pendingKey = false;
  }
}

export function buildAvcC(spsNal: Uint8Array, ppsNal: Uint8Array): Uint8Array | null {
  if (spsNal.length < 4 || ppsNal.length < 1) return null;
  const out = new Uint8Array(11 + spsNal.length + ppsNal.length);
  let i = 0;
  out[i++] = 1;
  out[i++] = spsNal[1] as number;
  out[i++] = spsNal[2] as number;
  out[i++] = spsNal[3] as number;
  out[i++] = 0xff;
  out[i++] = 0xe1;
  out[i++] = ((spsNal.length >> 8) & 0xff) as number;
  out[i++] = (spsNal.length & 0xff) as number;
  out.set(spsNal, i);
  i += spsNal.length;
  out[i++] = 1;
  out[i++] = ((ppsNal.length >> 8) & 0xff) as number;
  out[i++] = (ppsNal.length & 0xff) as number;
  out.set(ppsNal, i);
  return out;
}

export function codecString(spsNal: Uint8Array): string {
  const hex = (value: number): string => value.toString(16).padStart(2, '0');
  return `avc1.${hex(spsNal[1] as number)}${hex(spsNal[2] as number)}${hex(
    spsNal[3] as number,
  )}`;
}

/** 拆出所有 NAL（保留内容，不含起始码）。 */
export function splitNals(annexB: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const start = findStartCode(annexB, offset);
    if (!start) break;
    const next = findStartCode(annexB, start.index + start.length);
    const end = next ? next.index : annexB.length;
    nals.push(annexB.subarray(start.index + start.length, end));
    if (!next) break;
    offset = next.index;
  }
  return nals;
}

/** Annex-B → AVCC，供 WebCodecs 使用。 */
export function annexBToAvcc(annexB: Uint8Array): Uint8Array {
  const nals = splitNals(annexB);
  let size = 0;
  for (const nal of nals) size += 4 + nal.length;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const nal of nals) {
    out[offset++] = (nal.length >>> 24) & 0xff;
    out[offset++] = (nal.length >>> 16) & 0xff;
    out[offset++] = (nal.length >>> 8) & 0xff;
    out[offset++] = nal.length & 0xff;
    out.set(nal, offset);
    offset += nal.length;
  }
  return out;
}