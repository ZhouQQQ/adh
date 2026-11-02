import { execFile } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** 命令不存在或无法启动。 */
  failedToStart: boolean;
}

export function runCommand(
  command: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const errno = error as NodeJS.ErrnoException | null;
        const rawCode: unknown = errno?.code;
        const failedToStart = error !== null && typeof rawCode === 'string';
        const code = typeof rawCode === 'number' ? rawCode : error ? 1 : 0;
        resolve({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          failedToStart,
        });
      },
    );
  });
}

/** 命令是否存在且可执行。 */
export async function commandExists(
  command: string,
  args: string[] = ['--version'],
): Promise<boolean> {
  const result = await runCommand(command, args, 5_000);
  return !result.failedToStart;
}

/** 需要二进制输出的场景，例如 `adb exec-out screencap -p`。 */
export function runCommandBuffer(
  command: string,
  args: string[],
  timeoutMs = 20_000,
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'buffer',
      },
      (error, stdout, stderr) => {
        const errno = error as NodeJS.ErrnoException | null;
        const rawCode: unknown = errno?.code;
        const code = typeof rawCode === 'number' ? rawCode : error ? 1 : 0;
        resolve({
          code,
          stdout: stdout as Buffer,
          stderr: (stderr as Buffer).toString('utf8'),
        });
      },
    );
  });
}