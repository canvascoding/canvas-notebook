import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CommandRunner, RuntimeContext } from './types';
import { runOrThrow } from './process';

const CLI_ASSET_NAME = 'canvas-notebook-cli.tar.gz';
const CHECKSUM_ASSET_NAME = 'canvas-notebook-cli.sha256';
const RELEASE_VERSION_PATTERN = /^\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/u;

export interface PortableCliUpdateResult {
  skipped: boolean;
  changed: boolean;
  currentRoot: string;
  mainPath: string;
  beforeVersion: string;
  afterVersion: string;
}

function isFalse(value: string | undefined): boolean {
  return ['false', '0', 'no', 'off', 'disabled'].includes(String(value || '').trim().toLowerCase());
}

function isManagedByControlPlane(env: NodeJS.ProcessEnv): boolean {
  const managed = String(env.CANVAS_MANAGED_SERVICES_ENABLED || '').trim().toLowerCase();
  return ['true', '1', 'yes', 'on'].includes(managed) || String(env.CANVAS_CONTROL_PLANE_URL || '').trim().length > 0;
}

function assetUrl(env: NodeJS.ProcessEnv, asset: string): string {
  const repo = env.CANVAS_REPO || 'canvascoding/canvas-notebook';
  const version = env.CANVAS_VERSION || env.CANVAS_CLI_VERSION || 'latest';
  if (env.CANVAS_CLI_BASE_URL) return `${env.CANVAS_CLI_BASE_URL.replace(/\/+$/u, '')}/${asset}`;
  if (env.CANVAS_CLI_URL && asset === CLI_ASSET_NAME) return env.CANVAS_CLI_URL;
  if (env.CANVAS_CLI_SHA256_URL && asset === CHECKSUM_ASSET_NAME) return env.CANVAS_CLI_SHA256_URL;
  if (!version || version === 'latest') return `https://github.com/${repo}/releases/latest/download/${asset}`;
  return `https://github.com/${repo}/releases/download/${version.replace(/^refs\/tags\//u, '')}/${asset}`;
}

export function resolvePortableCliRoot(env: NodeJS.ProcessEnv = process.env, argvMain = process.argv[1] || ''): string {
  if (env.CANVAS_CLI_ROOT) return path.resolve(env.CANVAS_CLI_ROOT);
  if (!argvMain) return '';
  const mainPath = path.resolve(argvMain);
  if (path.basename(mainPath) !== 'main.js') return '';
  if (path.basename(path.dirname(mainPath)) !== 'dist-cli') return '';
  return path.dirname(path.dirname(mainPath));
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

async function isPackagedPortableRoot(root: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!root) return false;
  if (env.CANVAS_CLI_SELF_UPDATE_ALLOW_LOCAL === 'true') return true;
  if (!await exists(path.join(root, 'dist-cli', 'main.js'))) return false;
  if (await exists(path.join(root, 'package.json'))) return false;
  return exists(path.join(root, 'README.txt'));
}

async function readVersion(root: string): Promise<string> {
  const versionPath = path.join(root, 'VERSION');
  const packagePath = path.join(root, 'package.json');
  const version = await fs.readFile(versionPath, 'utf8').then((text) => text.trim(), () => '');
  if (version) return version;
  return fs.readFile(packagePath, 'utf8')
    .then((text) => {
      const parsed = JSON.parse(text) as { version?: string };
      return parsed.version || '';
    })
    .catch(() => '');
}

async function downloadFile(url: string, outputPath: string): Promise<void> {
  if (url.startsWith('file://')) {
    await fs.copyFile(fileURLToPath(url), outputPath);
    return;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, bytes);
}

async function verifyChecksum(archivePath: string, checksumPath: string): Promise<void> {
  const expected = (await fs.readFile(checksumPath, 'utf8')).trim().split(/\s+/u)[0]?.toLowerCase();
  if (!expected) throw new Error('CLI checksum file is empty.');
  const archive = await fs.readFile(archivePath);
  const actual = crypto.createHash('sha256').update(archive).digest('hex').toLowerCase();
  if (actual !== expected) throw new Error('CLI checksum verification failed.');
}

async function isWritable(filePath: string): Promise<boolean> {
  return fs.access(filePath, fsConstants.W_OK).then(() => true, () => false);
}

function linuxArchitecture(env: NodeJS.ProcessEnv): 'amd64' | 'arm64' {
  const architecture = env.CANVAS_LINUX_CLI_ARCH || (process.arch === 'x64'
    ? 'amd64'
    : process.arch === 'arm64' ? 'arm64' : '');
  if (architecture !== 'amd64' && architecture !== 'arm64') {
    throw new Error(`Unsupported Linux CLI architecture: ${architecture || process.arch}`);
  }
  return architecture;
}

function linuxAssetUrl(env: NodeJS.ProcessEnv, asset: string, archiveName: string, checksumName: string): string {
  const repo = env.CANVAS_REPO || 'canvascoding/canvas-notebook';
  const version = env.CANVAS_VERSION || env.CANVAS_CLI_VERSION || 'latest';
  if (env.CANVAS_LINUX_CLI_BASE_URL) return `${env.CANVAS_LINUX_CLI_BASE_URL.replace(/\/+$/u, '')}/${asset}`;
  if (env.CANVAS_LINUX_CLI_URL && asset === archiveName) return env.CANVAS_LINUX_CLI_URL;
  if (env.CANVAS_LINUX_CLI_SHA256_URL && asset === checksumName) return env.CANVAS_LINUX_CLI_SHA256_URL;
  if (!version || version === 'latest') return `https://github.com/${repo}/releases/latest/download/${asset}`;
  return `https://github.com/${repo}/releases/download/${version.replace(/^refs\/tags\//u, '')}/${asset}`;
}

async function updateManagedLinuxCli(params: {
  runner: CommandRunner;
  env: NodeJS.ProcessEnv;
  currentRoot: string;
  beforeVersion: string;
}): Promise<PortableCliUpdateResult> {
  const linuxRoot = path.resolve(String(params.env.CANVAS_CLI_LINUX_ROOT || ''));
  const currentVersion = await fs.readFile(path.join(linuxRoot, 'state', 'current'), 'utf8')
    .then((value) => value.trim(), () => '');
  if (!RELEASE_VERSION_PATTERN.test(currentVersion)) throw new Error('Linux CLI current activation state is invalid.');
  const expectedCurrentRoot = path.join(linuxRoot, 'releases', currentVersion);
  if (path.resolve(params.currentRoot) !== expectedCurrentRoot) {
    throw new Error('Linux CLI root does not match its current activation state.');
  }
  const installer = path.join(linuxRoot, 'install', 'linux-cli.sh');
  const installerStat = await fs.lstat(installer).catch(() => null);
  if (!installerStat?.isFile() || installerStat.isSymbolicLink()) {
    throw new Error(`Linux CLI installer is missing or unsafe: ${installer}`);
  }

  const architecture = linuxArchitecture(params.env);
  const packageName = `canvas-notebook-linux-cli-${architecture}`;
  const archiveName = `${packageName}.tar.gz`;
  const checksumName = `${packageName}.sha256`;
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-linux-cli-update-'));
  try {
    const archivePath = path.join(tmpRoot, archiveName);
    const checksumPath = path.join(tmpRoot, checksumName);
    await downloadFile(linuxAssetUrl(params.env, archiveName, archiveName, checksumName), archivePath);
    await downloadFile(linuxAssetUrl(params.env, checksumName, archiveName, checksumName), checksumPath);
    await verifyChecksum(archivePath, checksumPath);
    const binPath = params.env.CANVAS_LINUX_CLI_BIN_PATH || params.env.CANVAS_CLI_PATH || '/usr/local/bin/canvas-notebook';
    const installerEnv = {
      ...params.env,
      CANVAS_LINUX_CLI_ROOT: linuxRoot,
      CANVAS_LINUX_CLI_BIN_PATH: binPath,
      CANVAS_LINUX_CLI_ARCHIVE: archivePath,
      CANVAS_LINUX_CLI_CHECKSUM: checksumPath,
      CANVAS_CLI_SELF_UPDATE_REEXEC: 'true',
    };
    const requiresSudo = typeof process.getuid === 'function' && process.getuid() !== 0 &&
      (!await isWritable(linuxRoot) || !await isWritable(path.dirname(binPath)));
    if (requiresSudo) {
      await runOrThrow(params.runner, 'sudo', [
        'env',
        `CANVAS_LINUX_CLI_ROOT=${linuxRoot}`,
        `CANVAS_LINUX_CLI_BIN_PATH=${binPath}`,
        `CANVAS_LINUX_CLI_ARCHIVE=${archivePath}`,
        `CANVAS_LINUX_CLI_CHECKSUM=${checksumPath}`,
        'CANVAS_CLI_SELF_UPDATE_REEXEC=true',
        'bash',
        installer,
        'install',
      ], { env: params.env, stdio: 'inherit' });
    } else {
      await runOrThrow(params.runner, 'bash', [installer, 'install'], { env: installerEnv, stdio: 'inherit' });
    }
    const afterVersion = await fs.readFile(path.join(linuxRoot, 'state', 'current'), 'utf8')
      .then((value) => value.trim(), () => '');
    if (!RELEASE_VERSION_PATTERN.test(afterVersion)) throw new Error('Linux CLI activation did not produce a valid current version.');
    const nextRoot = path.join(linuxRoot, 'releases', afterVersion);
    const mainPath = path.join(nextRoot, 'dist-cli', 'main.js');
    const mainStat = await fs.lstat(mainPath).catch(() => null);
    if (!mainStat?.isFile() || mainStat.isSymbolicLink()) {
      throw new Error(`Activated Linux CLI release is missing or unsafe: ${nextRoot}`);
    }
    return {
      skipped: false,
      changed: afterVersion !== currentVersion,
      currentRoot: nextRoot,
      mainPath,
      beforeVersion: params.beforeVersion || currentVersion,
      afterVersion,
    };
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function listFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = path.join(dir, entry.name);
      const relative = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(fullPath, relative);
      else if (entry.isFile()) output.push(relative);
    }
  }
  await walk(root, '');
  return output;
}

export async function portableCliFingerprint(root: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for (const relative of await listFiles(root)) {
    hash.update(relative.replace(/\\/gu, '/'));
    hash.update('\0');
    hash.update(await fs.readFile(path.join(root, relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function replaceDirectory(sourceRoot: string, targetRoot: string): Promise<void> {
  const parent = path.dirname(targetRoot);
  const backupRoot = path.join(parent, `.${path.basename(targetRoot)}.previous-${process.pid}-${Date.now()}`);
  let backupCreated = false;
  await fs.mkdir(parent, { recursive: true });
  try {
    await fs.rename(targetRoot, backupRoot);
    backupCreated = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await fs.rename(sourceRoot, targetRoot);
  } catch (error) {
    if (backupCreated) {
      await fs.rename(backupRoot, targetRoot).catch(() => undefined);
    }
    throw error;
  }
  if (backupCreated) {
    await fs.rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function updatePortableCli(params: {
  runner: CommandRunner;
  context: RuntimeContext;
  env?: NodeJS.ProcessEnv;
  argvMain?: string;
}): Promise<PortableCliUpdateResult> {
  const env = params.env || process.env;
  const currentRoot = resolvePortableCliRoot(env, params.argvMain);
  const mainPath = currentRoot ? path.join(currentRoot, 'dist-cli', 'main.js') : '';
  const beforeVersion = currentRoot ? await readVersion(currentRoot) : '';
  if (isManagedByControlPlane(env)) {
    return { skipped: true, changed: false, currentRoot, mainPath, beforeVersion, afterVersion: beforeVersion };
  }
  if (isFalse(env.CANVAS_CLI_SELF_UPDATE) || env.CANVAS_CLI_SELF_UPDATE_REEXEC === 'true') {
    return { skipped: true, changed: false, currentRoot, mainPath, beforeVersion, afterVersion: beforeVersion };
  }
  if (params.context.platform === 'linux' && env.CANVAS_CLI_LINUX_ROOT) {
    return updateManagedLinuxCli({ runner: params.runner, env, currentRoot, beforeVersion });
  }
  if (!await isPackagedPortableRoot(currentRoot, env)) {
    return { skipped: true, changed: false, currentRoot, mainPath, beforeVersion, afterVersion: beforeVersion };
  }

  const beforeFingerprint = await portableCliFingerprint(currentRoot);
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-cli-update-'));
  try {
    const archivePath = path.join(tmpRoot, CLI_ASSET_NAME);
    const checksumPath = path.join(tmpRoot, CHECKSUM_ASSET_NAME);
    const extractDir = path.join(tmpRoot, 'extract');
    await fs.mkdir(extractDir, { recursive: true });
    await downloadFile(assetUrl(env, CLI_ASSET_NAME), archivePath);
    await downloadFile(assetUrl(env, CHECKSUM_ASSET_NAME), checksumPath);
    await verifyChecksum(archivePath, checksumPath);
    const tarBin = params.context.platform === 'windows' ? 'tar.exe' : 'tar';
    await runOrThrow(params.runner, tarBin, ['-xzf', archivePath, '-C', extractDir]);
    const nextRoot = path.join(extractDir, 'canvas-notebook-cli');
    const nextMain = path.join(nextRoot, 'dist-cli', 'main.js');
    if (!await exists(nextMain)) throw new Error('Downloaded CLI bundle is missing dist-cli/main.js.');
    const afterFingerprint = await portableCliFingerprint(nextRoot);
    const afterVersion = await readVersion(nextRoot);
    if (afterFingerprint === beforeFingerprint) {
      return { skipped: false, changed: false, currentRoot, mainPath, beforeVersion, afterVersion: afterVersion || beforeVersion };
    }
    await replaceDirectory(nextRoot, currentRoot);
    return {
      skipped: false,
      changed: true,
      currentRoot,
      mainPath,
      beforeVersion,
      afterVersion,
    };
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function portableCliReexecArgs(params: {
  command: string;
  args: string[];
  json: boolean;
  noBanner: boolean;
}): string[] {
  const args = [params.command];
  if (params.json) args.push('--json');
  if (params.noBanner) args.push('--no-banner');
  args.push(...params.args);
  return args;
}

export async function reexecPortableCliIfUpdated(params: {
  runner: CommandRunner;
  context: RuntimeContext;
  command: string;
  args: string[];
  json: boolean;
  noBanner: boolean;
}): Promise<void> {
  const eventStream = params.args.includes('--event-stream');
  let result: PortableCliUpdateResult;
  try {
    result = await updatePortableCli(params);
  } catch (error) {
    console.warn(`Could not update portable CLI before ${params.command}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (result.skipped && isManagedByControlPlane(process.env)) {
    if (!eventStream) console.log('Portable CLI self-update skipped: installation is managed by Control Plane.');
    return;
  }
  if (!result.changed) return;

  const versionText = result.beforeVersion || result.afterVersion
    ? ` ${result.beforeVersion || 'unknown'} -> ${result.afterVersion || 'unknown'}`
    : '';
  if (!eventStream) {
    console.log(`Portable CLI updated${versionText}`);
    console.log(`Restarting ${params.command} with updated CLI...`);
  }
  const child = spawn(process.execPath, [result.mainPath, ...portableCliReexecArgs(params)], {
    env: {
      ...process.env,
      CANVAS_CLI_ROOT: result.currentRoot,
      CANVAS_CLI_SELF_UPDATE_REEXEC: 'true',
      CANVAS_OPERATION_LOCK_INHERIT_TOKEN: process.env.CANVAS_OPERATION_LOCK_NONCE,
    },
    stdio: 'inherit',
    windowsHide: true,
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 0));
  });
  process.exit(exitCode);
}
