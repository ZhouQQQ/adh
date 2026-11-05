/**
 * adh-agent 自更新。
 *
 * 设计要点：
 * - 只支持「打包后的安装目录」，源码目录（没有 src/cli.js）直接拒绝，避免把仓库改坏。
 * - 替换进程独立于当前进程（写到系统临时目录再执行），否则无法替换自身文件。
 * - 原地替换：安装目录名保持不变，现有计划任务 / 快捷方式继续有效。
 * - Windows 上先 rename 旧目录再放新目录，失败可回滚；旧版本目录保留，供 --rollback。
 * - 更新源默认 GitHub Release，可用 --source / ADH_AGENT_RELEASE_REPO 改到内网镜像。
 */
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { configFilePath } from './local-config.js';

const DEFAULT_REPO = 'ZhouQQQ/adh';
const MANIFEST_FILE = 'adh-agent-manifest.json';
const STATE_FILE = path.join(os.homedir(), '.adh', 'update-state.json');
const LOG_FILE = path.join(os.homedir(), '.adh', 'update.log');

export interface AgentReleaseEntry {
  /** 发布包文件名，例如 adh-agent-win32.zip。 */
  file?: string;
  /** 绝对下载地址；缺省时用 manifest 所在目录 + file。 */
  url?: string;
  /** 安装包 sha256（十六进制）。 */
  sha256?: string;
  /** 字节数，仅用于展示。 */
  size?: number;
}

export interface AgentManifest {
  version: string;
  releasedAt?: string;
  minNode?: string;
  notes?: string;
  platforms: Record<string, AgentReleaseEntry>;
}

export interface UpdateOptions {
  check?: boolean;
  rollback?: boolean;
  source?: string;
  fromFile?: string;
  sha256?: string;
  force?: boolean;
  yes?: boolean;
  noRestart?: boolean;
}

interface UpdateState {
  backupDir: string;
  previousVersion: string;
  currentVersion: string;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function stamp(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function log(message: string): void {
  console.log(`${stamp()} ${message}`);
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function formatDate(ms: number): string {
  return stamp(new Date(ms));
}

function isHttp(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/* ------------------------------------------------------------------ */
/* 版本与安装目录                                                      */
/* ------------------------------------------------------------------ */

/** 安装目录：打包后 src/update.js 的上一级；测试时可用 ADH_AGENT_INSTALL_DIR 覆盖。 */
export function resolveInstallDir(): string {
  const override = process.env.ADH_AGENT_INSTALL_DIR?.trim();
  if (override) return path.resolve(override);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function entryFile(dir: string): string {
  return path.join(dir, 'bin', 'adh-agent.mjs');
}

function isPackagedInstall(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, 'src', 'cli.js')) &&
    fs.existsSync(entryFile(dir))
  );
}

function assertPackagedInstall(dir: string): void {
  if (isPackagedInstall(dir)) return;
  throw new Error(
    `当前目录不是 adh-agent 安装包：${dir}\n` +
      '源码调试目录不支持自更新，请下载发布包解压后再执行。',
  );
}

function versionFromDir(dir: string): string | null {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version
      ? pkg.version.replace(/^v/i, '')
      : null;
  } catch {
    return null;
  }
}

function readState(): UpdateState | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as UpdateState;
  } catch {
    return null;
  }
}

/** 当前运行版本：ADH_VERSION > 安装目录 package.json > 上次更新记录。 */
export function currentVersion(installDir = resolveInstallDir()): string {
  const injected = process.env.ADH_VERSION?.trim();
  if (injected) return injected.replace(/^v(?=\d)/i, '');
  return (
    versionFromDir(installDir) ??
    readState()?.currentVersion ??
    '0.0.0'
  );
}

function parseVersion(raw: string): number[] | null {
  const match = raw.trim().match(/^v?(\d+(?:\.\d+)*)/i);
  if (!match?.[1]) return null;
  return match[1].split('.').map((part) => Number(part));
}

/** 只比较数字段；无法解析时退回字符串比较。 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    if (a === b) return 0;
    return a > b ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* manifest 与下载                                                     */
/* ------------------------------------------------------------------ */

function defaultManifestUrl(): string {
  const repo = (process.env.ADH_AGENT_RELEASE_REPO ?? DEFAULT_REPO).trim();
  const tag = (process.env.ADH_AGENT_RELEASE_TAG ?? '').trim();
  const base = tag
    ? `https://github.com/${repo}/releases/download/${tag}`
    : `https://github.com/${repo}/releases/latest/download`;
  return `${base}/${MANIFEST_FILE}`;
}

interface ManifestSource {
  manifestUrl: string;
  /** 解析 file 时的基地址（URL 或本地目录）。 */
  base: string;
}

function resolveSource(source?: string): ManifestSource {
  if (!source?.trim()) {
    const manifestUrl = defaultManifestUrl();
    return { manifestUrl, base: manifestUrl.slice(0, manifestUrl.lastIndexOf('/')) };
  }

  const value = source.trim().replace(/[\\/]+$/, '');
  if (isHttp(value)) {
    if (/\.json$/i.test(value)) {
      return {
        manifestUrl: value,
        base: value.slice(0, value.lastIndexOf('/')),
      };
    }
    return { manifestUrl: `${value}/${MANIFEST_FILE}`, base: value };
  }

  const absolute = path.resolve(value);
  const stat = fs.statSync(absolute);
  if (stat.isDirectory()) {
    return {
      manifestUrl: path.join(absolute, MANIFEST_FILE),
      base: absolute,
    };
  }
  return { manifestUrl: absolute, base: path.dirname(absolute) };
}

function parseManifest(raw: unknown): AgentManifest {
  const value = raw as Partial<AgentManifest> | null;
  if (!value || typeof value !== 'object') {
    throw new Error('manifest 格式错误：不是 JSON 对象');
  }
  if (typeof value.version !== 'string' || !value.version.trim()) {
    throw new Error('manifest 格式错误：缺少 version');
  }
  if (!value.platforms || typeof value.platforms !== 'object') {
    throw new Error('manifest 格式错误：缺少 platforms');
  }
  return value as AgentManifest;
}

async function loadManifest(
  source: ManifestSource,
): Promise<AgentManifest> {
  if (isHttp(source.manifestUrl)) {
    const response = await fetch(source.manifestUrl, {
      redirect: 'follow',
      headers: { 'user-agent': 'adh-agent' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(
        `获取版本清单失败（HTTP ${response.status}）：${source.manifestUrl}`,
      );
    }
    const text = (await response.text()).replace(/^\uFEFF/, '');
    return parseManifest(JSON.parse(text));
  }

  // Windows 记事本 / PowerShell Set-Content 可能写入 UTF-8 BOM
  const text = fs
    .readFileSync(source.manifestUrl, 'utf8')
    .replace(/^\uFEFF/, '');
  return parseManifest(JSON.parse(text));
}

function releaseFor(
  manifest: AgentManifest,
  platform = process.platform,
): AgentReleaseEntry {
  const entry = manifest.platforms[platform];
  if (!entry) {
    throw new Error(
      `版本清单里没有 ${platform} 平台（可选：${Object.keys(manifest.platforms).join(', ')}）`,
    );
  }
  return entry;
}

function downloadUrlFor(entry: AgentReleaseEntry, base: string): string {
  if (entry.url && isHttp(entry.url)) return entry.url;
  if (!entry.file) {
    throw new Error('版本清单缺少 file 或 url');
  }
  return isHttp(base) ? `${base}/${entry.file}` : path.join(base, entry.file);
}

async function downloadTo(
  url: string,
  dest: string,
  label: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!isHttp(url)) {
    const stat = fs.statSync(url);
    fs.copyFileSync(url, dest);
    log(`使用本地安装包 ${label}（${formatSize(stat.size)}）`);
    return;
  }

  log(`下载 ${label}：${url}`);
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'adh-agent' },
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`${label} 下载失败（HTTP ${response.status}）`);
  }
  await pipeline(
    Readable.fromWeb(response.body as never),
    fs.createWriteStream(dest),
  );
  log(`下载完成 ${label}（${formatSize(fs.statSync(dest).size)}）`);
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/* ------------------------------------------------------------------ */
/* 解压与安装包校验                                                    */
/* ------------------------------------------------------------------ */

/** 压缩包内可能有一层 adh-agent-<platform>-v<version>/ 目录。 */
function findPayloadRoot(dir: string, depth = 0): string | null {
  if (depth > 2) return null;
  if (
    fs.existsSync(path.join(dir, 'src', 'cli.js')) &&
    fs.existsSync(path.join(dir, 'bin', 'adh-agent.mjs'))
  ) {
    return dir;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findPayloadRoot(path.join(dir, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

function extractPayload(zipPath: string, workDir: string): string {
  const target = path.join(workDir, 'payload');
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  new AdmZip(zipPath).extractAllTo(target, true);

  const root = findPayloadRoot(target);
  if (!root) {
    throw new Error('安装包内容不完整：缺少 src/cli.js 或 bin/adh-agent.mjs');
  }
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    throw new Error('安装包内容不完整：缺少 package.json');
  }
  return root;
}

function makeWorkDir(installDir: string): string {
  const candidates = [
    path.join(path.dirname(installDir), `.adh-update-${Date.now()}`),
    path.join(os.tmpdir(), `adh-update-${Date.now()}`),
  ];
  let lastError: unknown = null;
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: false });
      return dir;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `无法创建更新临时目录：${lastError instanceof Error ? lastError.message : lastError}`,
  );
}

function backupDirFor(installDir: string, version: string): string {
  const safe = version.replace(/[^\w.-]+/g, '_');
  return `${installDir}.bak-${safe}-${Date.now()}`;
}

/* ------------------------------------------------------------------ */
/* 确认与重启判断                                                      */
/* ------------------------------------------------------------------ */

async function confirm(question: string, yes?: boolean): Promise<boolean> {
  if (yes || !process.stdin.isTTY) return true;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function hasSavedConnection(): boolean {
  try {
    const config = JSON.parse(fs.readFileSync(configFilePath(), 'utf8')) as {
      serverUrl?: unknown;
      token?: unknown;
    };
    return Boolean(config.serverUrl) && Boolean(config.token);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 独立更新进程                                                        */
/* ------------------------------------------------------------------ */

/**
 * helper 必须是自包含脚本：它运行在系统临时目录，不引用安装包内的模块，
 * 否则安装包被替换时会把 helper 自己也换掉。
 */
const HELPER_SOURCE = String.raw`
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const STATE = JSON.parse(process.env.ADH_UPDATE_STATE || '{}');
const { installDir, payloadRoot, backupDir, logFile, restart, oldVersion, newVersion, oldPid } = STATE;

function pad(n) { return String(n).padStart(2, '0'); }
function stamp() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
function log(msg) {
  const line = stamp() + ' ' + msg;
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch {}
}
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function killTree(pid) {
  if (!pid || !alive(pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  for (let i = 0; i < 40 && alive(pid); i += 1) sleep(200);
  if (alive(pid) && process.platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}
function readPid() {
  try {
    const value = Number(fs.readFileSync(path.join(os.homedir(), '.adh', 'agent.pid'), 'utf8').trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}
function removeDir(dir) {
  for (let i = 0; i < 4; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return true;
    } catch (error) {
      log('清理目录失败：' + error.message);
      sleep(500);
    }
  }
  return false;
}
function moveDir(from, to) {
  try {
    fs.renameSync(from, to);
    return;
  } catch (error) {
    log('目录改名失败，改用复制：' + error.message);
  }
  fs.cpSync(from, to, { recursive: true });
  removeDir(from);
}
function writeState(previous, current) {
  try {
    fs.writeFileSync(
      path.join(os.homedir(), '.adh', 'update-state.json'),
      JSON.stringify({ backupDir, previousVersion: previous, currentVersion: current, updatedAt: Date.now() }, null, 2) + '\n',
    );
  } catch {}
}
function startAgent() {
  const entry = path.join(installDir, 'bin', 'adh-agent.mjs');
  if (!fs.existsSync(entry)) throw new Error('缺少启动脚本 ' + entry);
  const child = spawn(process.execPath, [entry, 'start'], {
    cwd: os.homedir(),
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, ADH_DAEMON: '' },
  });
  child.unref();
}
function waitForAgent(beforePid) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const pid = readPid();
    if (pid && pid !== beforePid && alive(pid)) return pid;
    sleep(300);
  }
  return null;
}
function keepVendor() {
  try {
    const oldVendor = path.join(backupDir, 'vendor');
    const newVendor = path.join(installDir, 'vendor');
    if (fs.existsSync(oldVendor) && !fs.existsSync(newVendor)) {
      fs.cpSync(oldVendor, newVendor, { recursive: true });
      log('已保留旧版内置工具 vendor/');
    }
  } catch (error) {
    log('保留 vendor 失败（不影响启动）：' + error.message);
  }
}
function pruneBackups(keep) {
  try {
    const parent = path.dirname(installDir);
    const prefix = path.basename(installDir) + '.bak-';
    const dirs = fs.readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => {
        const full = path.join(parent, entry.name);
        return { full, at: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.at - a.at);
    for (const item of dirs.slice(keep)) {
      removeDir(item.full);
      log('已清理旧备份 ' + item.full);
    }
  } catch (error) {
    log('清理旧备份失败：' + error.message);
  }
}

log('开始更新 v' + oldVersion + ' -> v' + newVersion + '，安装目录 ' + installDir);
killTree(oldPid);
sleep(800);

if (!fs.existsSync(payloadRoot)) {
  log('新版本目录不存在：' + payloadRoot);
  process.exit(10);
}
if (!removeDir(backupDir)) {
  log('无法清理旧备份目录：' + backupDir);
  process.exit(10);
}
try {
  fs.renameSync(installDir, backupDir);
} catch (error) {
  log('备份旧版本失败：' + error.message);
  process.exit(10);
}

let installed = false;
try {
  moveDir(payloadRoot, installDir);
  installed = true;
} catch (error) {
  log('写入新版本失败：' + error.message);
}

if (!installed) {
  removeDir(installDir);
  moveDir(backupDir, installDir);
  log('已恢复旧版本，更新中止');
  process.exit(11);
}
keepVendor();

if (!restart) {
  writeState(oldVersion, newVersion);
  pruneBackups(2);
  log('文件已更新，按 --no-restart 未重启，请手动执行 adh-agent start');
  process.exit(0);
}

let pid = null;
try {
  startAgent();
  pid = waitForAgent(oldPid);
} catch (error) {
  log('启动新版本失败：' + error.message);
}

if (pid) {
  writeState(oldVersion, newVersion);
  pruneBackups(2);
  log('更新完成，新进程 PID ' + pid);
  process.exit(0);
}

log('新版本未能启动，开始回滚');
try { killTree(readPid()); } catch {}
removeDir(installDir);
try {
  moveDir(backupDir, installDir);
} catch (error) {
  log('回滚恢复文件失败：' + error.message);
  process.exit(12);
}
try {
  startAgent();
} catch (error) {
  log('回滚启动失败：' + error.message);
  process.exit(13);
}
const restored = waitForAgent(oldPid);
if (restored) {
  pruneBackups(2);
  log('已回滚到 v' + oldVersion + '，PID ' + restored);
  process.exit(2);
}
log('回滚后仍未能启动，请手动执行 adh-agent doctor 检查');
process.exit(3);
`;

interface HelperState {
  installDir: string;
  payloadRoot: string;
  backupDir: string;
  logFile: string;
  restart: boolean;
  oldVersion: string;
  newVersion: string;
  oldPid: number | null;
}

function readDaemonPid(): number | null {
  try {
    const value = Number(
      fs.readFileSync(path.join(os.homedir(), '.adh', 'agent.pid'), 'utf8').trim(),
    );
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function runHelper(state: HelperState): Promise<number> {
  const helperDir = path.join(os.tmpdir(), `adh-update-helper-${Date.now()}`);
  fs.mkdirSync(helperDir, { recursive: true });
  const helperPath = path.join(helperDir, 'update-helper.mjs');
  fs.writeFileSync(helperPath, HELPER_SOURCE, 'utf8');

  try {
    const child = spawn(process.execPath, [helperPath], {
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, ADH_UPDATE_STATE: JSON.stringify(state) },
    });
    return await new Promise<number>((resolve, reject) => {
      child.on('exit', (code) => resolve(code ?? 1));
      child.on('error', reject);
    });
  } finally {
    fs.rmSync(helperDir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* 对外命令                                                            */
/* ------------------------------------------------------------------ */

export async function runUpdateCheck(options: UpdateOptions): Promise<void> {
  const installDir = resolveInstallDir();
  assertPackagedInstall(installDir);

  const source = resolveSource(options.source);
  const manifest = await loadManifest(source);
  const entry = releaseFor(manifest);
  const current = currentVersion(installDir);
  const diff = compareVersions(manifest.version, current);

  console.log(`\nadh-agent 更新检查 · ${stamp()}`);
  console.log(`  安装目录  ${installDir}`);
  console.log(`  当前版本  v${current}`);
  console.log(`  最新版本  v${manifest.version}`);
  if (manifest.releasedAt) {
    const releasedAt = Date.parse(manifest.releasedAt);
    console.log(
      `  发布时间  ${
        Number.isNaN(releasedAt) ? manifest.releasedAt : formatDate(releasedAt)
      }`,
    );
  }
  console.log(`  平台      ${process.platform}`);
  if (entry.file) console.log(`  安装包    ${entry.file}`);
  if (entry.size) console.log(`  包大小    ${formatSize(entry.size)}`);
  if (entry.sha256) console.log(`  sha256    ${entry.sha256}`);
  if (manifest.notes) console.log(`  说明      ${manifest.notes}`);
  console.log(
    `  状态      ${
      diff > 0 ? '有新版本，执行 adh-agent update 升级' : '已是最新版本'
    }\n`,
  );
}

export async function runUpdate(options: UpdateOptions): Promise<void> {
  const installDir = resolveInstallDir();
  assertPackagedInstall(installDir);

  const oldVersion = currentVersion(installDir);
  let newVersion = oldVersion;
  let zipPath = '';
  let workDir = '';
  let manifestEntry: AgentReleaseEntry | null = null;
  let manifestBase = '';

  if (options.fromFile) {
    zipPath = path.resolve(options.fromFile);
    if (!fs.existsSync(zipPath)) {
      throw new Error(`找不到安装包：${zipPath}`);
    }
  } else {
    const source = resolveSource(options.source);
    const manifest = await loadManifest(source);
    manifestEntry = releaseFor(manifest);

    if (compareVersions(manifest.version, oldVersion) <= 0 && !options.force) {
      console.log(
        `\n当前已是最新版本 v${oldVersion}（清单 v${manifest.version}）。` +
          '\n如需强制重装，执行 adh-agent update --force\n',
      );
      return;
    }

    newVersion = manifest.version;
    manifestBase = source.base;
    log(`发现新版本 v${newVersion}（当前 v${oldVersion}）`);
  }

  workDir = makeWorkDir(installDir);
  try {
    const targetZip = options.fromFile
      ? zipPath
      : path.join(workDir, manifestEntry?.file ?? `adh-agent-${process.platform}.zip`);
    if (!options.fromFile) {
      await downloadTo(
        downloadUrlFor(manifestEntry!, manifestBase),
        targetZip,
        `adh-agent-${process.platform}.zip`,
      );
    }
    zipPath = targetZip;

    const expected = options.sha256?.trim() || manifestEntry?.sha256?.trim();
    if (expected) {
      const actual = await sha256Of(zipPath);
      if (actual.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(
          `安装包校验失败：期望 ${expected}，实际 ${actual}，已中止更新`,
        );
      }
      log('安装包 sha256 校验通过');
    } else {
      log('警告：版本清单未提供 sha256，跳过完整性校验');
    }

    const payloadRoot = extractPayload(zipPath, workDir);
    if (!options.fromFile) {
      newVersion = versionFromDir(payloadRoot) ?? newVersion;
    } else {
      newVersion = versionFromDir(payloadRoot) ?? oldVersion;
    }

    if (
      !options.force &&
      compareVersions(newVersion, oldVersion) <= 0 &&
      options.fromFile
    ) {
      console.log(
        `\n安装包版本 v${newVersion} 不高于当前 v${oldVersion}。` +
          '\n如需强制重装，加 --force\n',
      );
      return;
    }

    const restart = !options.noRestart && hasSavedConnection();
    if (!restart && !options.noRestart) {
      log('未找到已保存的连接配置，更新后不会自动启动，请手动执行 adh-agent start');
    }

    const confirmed = await confirm(
      `即将从 v${oldVersion} 更新到 v${newVersion}，期间设备会短暂断开。是否继续？`,
      options.yes,
    );
    if (!confirmed) {
      console.log('已取消更新。');
      return;
    }

    const state: HelperState = {
      installDir,
      payloadRoot,
      backupDir: backupDirFor(installDir, oldVersion),
      logFile: LOG_FILE,
      restart,
      oldVersion,
      newVersion,
      oldPid: readDaemonPid(),
    };

    log('停止旧进程并替换文件…');
    const code = await runHelper(state);
    if (code === 0) {
      log(`更新成功：v${oldVersion} → v${newVersion}`);
      log(`备份目录：${state.backupDir}（可用 adh-agent update --rollback 回退）`);
      log(`更新日志：${LOG_FILE}`);
      return;
    }
    if (code === 2) {
      throw new Error('新版本启动失败，已自动回滚到旧版本。请查看更新日志。');
    }
    if (code === 3) {
      throw new Error('新版本启动失败且回滚启动失败，请手动检查 adh-agent doctor。');
    }
    throw new Error(`更新失败（退出码 ${code}），详见 ${LOG_FILE}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export async function runRollback(options: UpdateOptions): Promise<void> {
  const installDir = resolveInstallDir();
  assertPackagedInstall(installDir);

  const state = readState();
  if (!state?.backupDir) {
    throw new Error('没有可回滚的版本记录，请先执行一次 adh-agent update');
  }
  if (!fs.existsSync(state.backupDir)) {
    throw new Error(`备份目录不存在：${state.backupDir}`);
  }
  if (!isPackagedInstall(state.backupDir)) {
    throw new Error(`备份目录内容不完整：${state.backupDir}`);
  }

  const current = currentVersion(installDir);
  const target = versionFromDir(state.backupDir) ?? state.previousVersion ?? 'unknown';
  const restart = !options.noRestart && hasSavedConnection();

  const confirmed = await confirm(
    `即将回滚 v${current} → v${target}，期间设备会短暂断开。是否继续？`,
    options.yes,
  );
  if (!confirmed) {
    console.log('已取消回滚。');
    return;
  }

  const helperState: HelperState = {
    installDir,
    payloadRoot: state.backupDir,
    backupDir: backupDirFor(installDir, current),
    logFile: LOG_FILE,
    restart,
    oldVersion: current,
    newVersion: target,
    oldPid: readDaemonPid(),
  };

  log('停止旧进程并回滚文件…');
  const code = await runHelper(helperState);
  if (code === 0) {
    log(`回滚成功：v${current} → v${target}`);
    log(`当前版本的备份目录：${helperState.backupDir}`);
    return;
  }
  if (code === 2) {
    throw new Error('回滚版本启动失败，已自动恢复到回滚前版本。请查看更新日志。');
  }
  throw new Error(`回滚失败（退出码 ${code}），详见 ${LOG_FILE}`);
}