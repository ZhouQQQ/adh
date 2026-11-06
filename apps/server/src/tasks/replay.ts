import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AiFrame, AiFrameAction } from '../ai/types.js';

/** 单个任务最多保存多少帧，防止异常长任务把磁盘写满。 */
const MAX_FRAMES = 80;

export interface RecordingFrame {
  /** 文件名，例如 0001.jpg。 */
  file: string;
  /** 截图时间戳。 */
  at: number;
  phase: 'initial' | 'after_action';
  summary: string;
  width: number;
  height: number;
  actions: AiFrameAction[];
}

export interface RecordingIndex {
  taskId: string;
  createdAt: number;
  frames: RecordingFrame[];
}

const TASK_ID_PATTERN = /^[A-Za-z0-9-]+$/;
const FRAME_FILE_PATTERN = /^\d{4}\.jpg$/;

function safeTaskId(taskId: string): string | null {
  return TASK_ID_PATTERN.test(taskId) ? taskId : null;
}

/** 为一个任务写截图帧和 index.json，供回放页读取。 */
export class TaskRecorder {
  private readonly frames: RecordingFrame[] = [];
  private writes: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly taskId: string,
    private readonly dir: string,
  ) {}

  /** 非阻塞追加一帧；写盘失败不会影响任务本身。 */
  add(frame: AiFrame): void {
    if (this.closed || this.frames.length >= MAX_FRAMES) return;

    const index = this.frames.length + 1;
    const file = `${String(index).padStart(4, '0')}.jpg`;
    this.frames.push({
      file,
      at: frame.at,
      phase: frame.phase,
      summary: frame.summary,
      width: frame.shot.width,
      height: frame.shot.height,
      actions: frame.actions,
    });

    const data = Buffer.from(frame.shot.base64, 'base64');
    this.writes = this.writes
      .then(() => fsp.writeFile(path.join(this.dir, file), data))
      .catch(() => undefined);
  }

  /** 等所有帧落盘后写索引。 */
  async finalize(): Promise<RecordingIndex> {
    if (!this.closed) {
      this.closed = true;
      await this.writes;
      const index: RecordingIndex = {
        taskId: this.taskId,
        createdAt: Date.now(),
        frames: this.frames,
      };
      await fsp
        .writeFile(
          path.join(this.dir, 'index.json'),
          JSON.stringify(index),
          'utf8',
        )
        .catch(() => undefined);
      return index;
    }
    return {
      taskId: this.taskId,
      createdAt: 0,
      frames: this.frames,
    };
  }
}

/** 回放文件存储：`.data/recordings/<taskId>/`。 */
export class TaskRecordingStore {
  constructor(private readonly rootDir: string) {
    fs.mkdirSync(rootDir, { recursive: true });
  }

  create(taskId: string): TaskRecorder | null {
    const safe = safeTaskId(taskId);
    if (!safe) return null;
    const dir = path.join(this.rootDir, safe);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return new TaskRecorder(safe, dir);
  }

  async read(taskId: string): Promise<RecordingIndex | null> {
    const safe = safeTaskId(taskId);
    if (!safe) return null;
    try {
      const raw = await fsp.readFile(
        path.join(this.rootDir, safe, 'index.json'),
        'utf8',
      );
      const parsed = JSON.parse(raw) as Partial<RecordingIndex>;
      if (!Array.isArray(parsed.frames)) return null;
      return {
        taskId: safe,
        createdAt: Number(parsed.createdAt) || 0,
        frames: parsed.frames.filter(
          (frame): frame is RecordingFrame =>
            Boolean(frame) &&
            typeof frame.file === 'string' &&
            FRAME_FILE_PATTERN.test(frame.file) &&
            typeof frame.at === 'number',
        ),
      };
    } catch {
      return null;
    }
  }

  /** 返回帧的绝对路径；文件名不合法或文件不存在时返回 null。 */
  framePath(taskId: string, file: string): string | null {
    const safe = safeTaskId(taskId);
    if (!safe || !FRAME_FILE_PATTERN.test(file)) return null;
    const target = path.join(this.rootDir, safe, file);
    if (!target.startsWith(path.join(this.rootDir, safe) + path.sep)) {
      return null;
    }
    return fs.existsSync(target) ? target : null;
  }

  /** 生成 32 位十六进制回放 token。 */
  static newToken(): string {
    return randomBytes(16).toString('hex');
  }
}