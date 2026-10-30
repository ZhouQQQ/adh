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
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
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