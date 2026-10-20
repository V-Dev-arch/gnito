import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DATA_DIR } from '../config.js';

const execFileAsync = promisify(execFile);
const DOCKER_BIN = process.env.GNITO_DOCKER_BIN || (process.platform === 'win32' ? 'docker.exe' : 'docker');
export const SANDBOX_IMAGE = process.env.GNITO_SANDBOX_IMAGE || 'gnito-sandbox:3.24.3';
export const SANDBOX_WORKSPACE = path.join(DATA_DIR, 'sandbox-workspace');
export const MAX_WORKSPACE_BYTES = 1024 * 1024 * 1024;
const DISK_FREE_RESERVE_BYTES = 512 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 32_000;
const MAX_TIMEOUT_MS = 300_000;
const WORKSPACE_SCAN_INTERVAL_MS = 250;
const CLEANUP_TIMEOUT_MS = 2_000;

export interface SandboxStatus {
  provider: 'docker';
  available: boolean;
  cliAvailable: boolean;
  daemonAvailable: boolean;
  imageAvailable: boolean;
  image: string;
  workspaceDir: string;
  workspaceLimitBytes: number;
  reason?: 'docker-not-installed' | 'docker-daemon-unavailable' | 'sandbox-image-not-built' | 'server-running-as-root';
}

function dockerEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH || '',
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
  };
}

async function dockerCheck(args: string[], timeout = 4_000): Promise<{ ok: boolean; value: string; code?: string }> {
  try {
    const result = await execFileAsync(DOCKER_BIN, args, {
      timeout,
      windowsHide: true,
      maxBuffer: 8_192,
      env: dockerEnvironment(),
    });
    return { ok: true, value: String(result.stdout).trim() };
  } catch (error: any) {
    return { ok: false, value: '', code: String(error?.code || error?.name || 'docker-error') };
  }
}

export async function getSandboxStatus(): Promise<SandboxStatus> {
  const base = { provider: 'docker' as const, image: SANDBOX_IMAGE, workspaceDir: SANDBOX_WORKSPACE, workspaceLimitBytes: MAX_WORKSPACE_BYTES };
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    return { ...base, available: false, cliAvailable: false, daemonAvailable: false, imageAvailable: false, reason: 'server-running-as-root' };
  }
  const cli = await dockerCheck(['--version']);
  if (!cli.ok) {
    return { ...base, available: false, cliAvailable: false, daemonAvailable: false, imageAvailable: false, reason: 'docker-not-installed' };
  }
  const [daemon, image] = await Promise.all([
    dockerCheck(['info', '--format', '{{.ServerVersion}}']),
    dockerCheck(['image', 'inspect', '--format', '{{.Id}}', SANDBOX_IMAGE]),
  ]);
  if (!daemon.ok) {
    return { ...base, available: false, cliAvailable: true, daemonAvailable: false, imageAvailable: false, reason: 'docker-daemon-unavailable' };
  }
  if (!image.ok) {
    return { ...base, available: false, cliAvailable: true, daemonAvailable: true, imageAvailable: false, reason: 'sandbox-image-not-built' };
  }
  return { ...base, available: true, cliAvailable: true, daemonAvailable: true, imageAvailable: true };
}

export function buildDockerRunArgs(options: {
  command: string;
  containerName: string;
  workspaceDir: string;
  image?: string;
  uid: number;
  gid: number;
  networkAccess?: boolean;
}): string[] {
  if (!Number.isInteger(options.uid) || options.uid < 1) throw new Error('Sandbox commands must use a non-root UID.');
  if (!Number.isInteger(options.gid) || options.gid < 0) throw new Error('Sandbox group ID is invalid.');
  if (options.workspaceDir.includes(',')) throw new Error('Sandbox workspace paths cannot contain commas.');
  return [
    'run', '--rm', '--pull=never', '--init', '--name', options.containerName,
    '--label', 'com.gnito.terminal-sandbox=true',
    `--network=${options.networkAccess ? 'bridge' : 'none'}`, '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', '--pids-limit=64',
    '--memory=512m', '--cpus=1', '--ulimit', 'nofile=256:256', '--ulimit', 'fsize=1073741824:1073741824',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777',
    '--user', `${options.uid}:${options.gid}`,
    '--env', 'HOME=/workspace/.home',
    '--env', 'XDG_CONFIG_HOME=/workspace/.home/.config',
    '--env', 'GH_CONFIG_DIR=/workspace/.home/.config/gh',
    '--env', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '--env', 'LANG=C.UTF-8',
    '--mount', `type=bind,source=${options.workspaceDir},target=/workspace`,
    '--workdir', '/workspace',
    options.image || SANDBOX_IMAGE,
    '/bin/sh', '-lc', options.command,
  ];
}

function ensureWorkspace(): string {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const dataRoot = fs.realpathSync(DATA_DIR);
  const workspace = path.join(dataRoot, 'sandbox-workspace');
  try {
    const stats = fs.lstatSync(workspace);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('The sandbox workspace path is not a real directory.');
    if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) throw new Error('The sandbox workspace belongs to a different OS user.');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    fs.mkdirSync(workspace, { mode: 0o700 });
  }
  fs.chmodSync(workspace, 0o700);
  const home = path.join(workspace, '.home');
  try {
    const stats = fs.lstatSync(home);
    if (stats.isSymbolicLink() || !stats.isDirectory() || (typeof process.getuid === 'function' && stats.uid !== process.getuid())) {
      throw new Error('The persistent sandbox home path is not a trusted directory.');
    }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    fs.mkdirSync(home, { mode: 0o700 });
  }
  fs.chmodSync(home, 0o700);
  return fs.realpathSync(workspace);
}

function measureWorkspaceBytes(root: string): number {
  const pending = [root];
  let bytes = 0;
  let entriesSeen = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch { return MAX_WORKSPACE_BYTES + 1; }
    for (const entry of entries) {
      if (++entriesSeen > 100_000) return MAX_WORKSPACE_BYTES + 1;
      const candidate = path.join(directory, entry.name);
      let stats: fs.Stats;
      try { stats = fs.lstatSync(candidate); }
      catch { return MAX_WORKSPACE_BYTES + 1; }
      if (stats.isDirectory() && !stats.isSymbolicLink()) pending.push(candidate);
      else bytes += stats.size;
      if (bytes > MAX_WORKSPACE_BYTES) return bytes;
    }
  }
  return bytes;
}

function freeBytes(root: string): number {
  const stats = fs.statfsSync(root);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function removeContainerVerified(name: string): Promise<boolean> {
  // Repeat removal and inspect twice while the daemon remains healthy. This
  // closes the race where `docker run` is being created as its CLI is killed.
  let absentChecks = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    const daemon = await dockerCheck(['info', '--format', '{{.ServerVersion}}'], CLEANUP_TIMEOUT_MS);
    if (!daemon.ok) return false;
    try {
      await execFileAsync(DOCKER_BIN, ['rm', '--force', name], {
        timeout: CLEANUP_TIMEOUT_MS, windowsHide: true, maxBuffer: 8_192, env: dockerEnvironment(),
      });
    } catch { /* inspect below; a missing container is an expected race */ }
    const inspect = await dockerCheck(['container', 'inspect', '--format', '{{.Id}}', name], CLEANUP_TIMEOUT_MS);
    if (!inspect.ok) {
      absentChecks++;
      if (absentChecks >= 2) return true;
    } else {
      absentChecks = 0;
    }
    await delay(150 + attempt * 100);
  }
  return false;
}

function cancelledError(cleanupVerified: boolean, reason: 'timeout' | 'cancelled' | 'quota'): string {
  const suffix = cleanupVerified
    ? ''
    : ' Container cleanup could not be verified; inspect Docker containers labeled com.gnito.terminal-sandbox=true before retrying.';
  if (reason === 'timeout') return `Terminal command timed out. The container was stopped.${suffix}`;
  if (reason === 'quota') return `Terminal workspace limit exceeded; the container was stopped. The workspace is limited to 1 GiB and the host must keep 512 MiB free.${suffix}`;
  return `Terminal command cancelled.${suffix}`;
}

export async function runSandboxCommand(command: string, timeoutMs: number, signal: AbortSignal, options: { networkAccess?: boolean; onOutput?: (output: { stdout: string; stderr: string }) => void } = {}): Promise<{ output?: { exitCode: number; stdout: string; stderr: string }; error?: string }> {
  const normalizedTimeout = Math.min(Math.max(timeoutMs, 1_000), MAX_TIMEOUT_MS);
  const status = await getSandboxStatus();
  if (!status.available) {
    const detail = status.reason === 'docker-not-installed'
      ? 'Docker is not installed.'
      : status.reason === 'docker-daemon-unavailable'
        ? 'The Docker daemon is not running or is not accessible.'
        : status.reason === 'sandbox-image-not-built'
          ? 'The Gnito sandbox image has not been built.'
          : 'Gnito is running as root; start it as a non-root OS user to enable Terminal.';
    return { error: `Terminal sandbox unavailable: ${detail} The host shell will not be used.` };
  }
  if (signal.aborted) return { error: 'Terminal command cancelled before launch.' };

  let workspace: string;
  let workspaceLimit: number;
  try {
    workspace = ensureWorkspace();
    const currentUsage = measureWorkspaceBytes(workspace);
    if (currentUsage > MAX_WORKSPACE_BYTES) return { error: 'Terminal workspace already exceeds its 1 GiB size limit. Remove files from ~/.gnito/sandbox-workspace before running another command.' };
    const available = freeBytes(workspace);
    workspaceLimit = Math.min(MAX_WORKSPACE_BYTES, currentUsage + Math.max(0, available - DISK_FREE_RESERVE_BYTES));
    if (workspaceLimit <= currentUsage) return { error: 'Not enough free disk space to safely run a terminal command; Gnito preserves at least 512 MiB for the host.' };
  } catch {
    return { error: 'Terminal sandbox workspace or its disk quota could not be checked safely.' };
  }

  const containerName = `gnito-terminal-${randomUUID()}`;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const group = typeof process.getgid === 'function' ? process.getgid() : 1000;
  const gid = group === 0 ? 1000 : group;
  let args: string[];
  try { args = buildDockerRunArgs({ command, containerName, workspaceDir: workspace, uid, gid, networkAccess: options.networkAccess }); }
  catch (error: any) { return { error: error?.message || 'Terminal sandbox configuration is invalid.' }; }

  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let stopReason: 'timeout' | 'cancelled' | 'quota' | null = null;
    let settled = false;
    let child: ReturnType<typeof spawn> | null = null;
    const timers: { timeout?: NodeJS.Timeout; quota?: NodeJS.Timeout } = {};

    const finish = (result: { output?: { exitCode: number; stdout: string; stderr: string }; error?: string }) => {
      if (settled) return;
      settled = true;
      if (timers.timeout) clearTimeout(timers.timeout);
      if (timers.quota) clearInterval(timers.quota);
      signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = () => {
      stopReason = stopReason || 'cancelled';
      child?.kill('SIGKILL');
    };

    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { finish({ error: 'Terminal command cancelled before launch.' }); return; }

    try {
      child = spawn(DOCKER_BIN, args, { shell: false, windowsHide: true, env: dockerEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish({ error: 'Docker could not start the isolated terminal container.' });
      return;
    }
    if (signal.aborted) onAbort();

    timers.timeout = setTimeout(() => {
      stopReason = stopReason || 'timeout';
      child?.kill('SIGKILL');
    }, normalizedTimeout);
    timers.quota = setInterval(() => {
      if (stopReason || settled) return;
      try {
        if (measureWorkspaceBytes(workspace) > workspaceLimit || freeBytes(workspace) < DISK_FREE_RESERVE_BYTES) {
          stopReason = 'quota';
          child?.kill('SIGKILL');
        }
      } catch {
        stopReason = 'quota';
        child?.kill('SIGKILL');
      }
    }, WORKSPACE_SCAN_INTERVAL_MS);

    const publishOutput = () => options.onOutput?.({ stdout, stderr });
    child.stdout?.on('data', (data: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += data.toString('utf8').slice(0, MAX_OUTPUT_CHARS - stdout.length);
      publishOutput();
    });
    child.stderr?.on('data', (data: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += data.toString('utf8').slice(0, MAX_OUTPUT_CHARS - stderr.length);
      publishOutput();
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') finish({ error: 'Docker CLI disappeared before the terminal sandbox could start. The host shell was not used.' });
      else finish({ error: 'Docker could not start the isolated terminal container.' });
    });
    child.on('close', async code => {
      if (settled) return;
      if (timers.timeout) clearTimeout(timers.timeout);
      if (timers.quota) clearInterval(timers.quota);
      if (stopReason) {
        const cleanupVerified = await removeContainerVerified(containerName);
        finish({ error: cancelledError(cleanupVerified, stopReason) });
        return;
      }
      if (measureWorkspaceBytes(workspace) > workspaceLimit) {
        finish({ error: 'Terminal workspace exceeded its 1 GiB storage limit. Remove files from ~/.gnito/sandbox-workspace before running another command.' });
        return;
      }
      finish({ output: { exitCode: code ?? 1, stdout, stderr } });
    });
  });
}

const SANDBOX_MEDIA_TYPES: Record<string, string> = {
  '.avif': 'image/avif', '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime',
  '.mp4': 'video/mp4', '.ogv': 'video/ogg', '.webm': 'video/webm',
};

/** Open only regular image/video files beneath the workspace, pinning every directory component without following symlinks. */
export function openSandboxMediaFile(workspacePath: string): { fd: number; path: string; filename: string; contentType: string; size: number } | null {
  if (workspacePath.length > 2_000 || !workspacePath.startsWith('/workspace/')) return null;
  const relative = workspacePath.slice('/workspace/'.length);
  const parts = relative.split('/');
  if (!relative || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'))) return null;
  const filename = parts[parts.length - 1];
  const contentType = SANDBOX_MEDIA_TYPES[path.extname(filename).toLowerCase()];
  if (!contentType) return null;
  if (!fs.constants.O_DIRECTORY || !fs.constants.O_NOFOLLOW) return null;
  const descriptorRoot = process.platform === 'linux' ? '/proc/self/fd'
    : process.platform === 'darwin' ? '/dev/fd' : '';
  if (!descriptorRoot || !fs.existsSync(descriptorRoot)) return null;
  let directoryFd: number | undefined;
  let fileFd: number | undefined;
  try {
    const root = fs.realpathSync(ensureWorkspace());
    const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
    directoryFd = fs.openSync(root, directoryFlags);
    for (const part of parts.slice(0, -1)) {
      const childFd = fs.openSync(`${descriptorRoot}/${directoryFd}/${part}`, directoryFlags);
      fs.closeSync(directoryFd);
      directoryFd = childFd;
    }
    fileFd = fs.openSync(`${descriptorRoot}/${directoryFd}/${filename}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK || 0));
    const stats = fs.fstatSync(fileFd);
    if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_WORKSPACE_BYTES) return null;
    const result = { fd: fileFd, path: workspacePath, filename, contentType, size: stats.size };
    fileFd = undefined;
    return result;
  } catch { return null; }
  finally {
    if (fileFd !== undefined) { try { fs.closeSync(fileFd); } catch {} }
    if (directoryFd !== undefined) { try { fs.closeSync(directoryFd); } catch {} }
  }
}
