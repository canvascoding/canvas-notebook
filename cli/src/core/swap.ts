import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CanvasCliConfig, CommandRunner, RuntimeContext } from './types';

const MIN_SWAP_BYTES = 128 * 1024 * 1024;
const MAX_SWAP_BYTES = 16 * 1024 * 1024 * 1024;
const MANAGED_FSTAB_MARKER = '# canvas-notebook swap';

export interface SwapStatus {
  enabled: boolean;
  active: boolean;
  file: string;
  activeFile: string | null;
  configuredSize: string;
  actualSizeBytes: number | null;
  persistent: boolean;
  swappiness: number;
  configuredSwappiness: number;
  inSync: boolean;
  error: string | null;
}

interface SwapPaths {
  managedFile: string;
  fstab: string;
  procSwaps: string;
  runtimeSwappiness: string;
  sysctl: string;
  state: string;
}

interface SwapState {
  identity: string;
  mode: 'normal' | 'secure';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Swap reconciliation failed';
}

function parseBoolean(value: unknown): boolean | null {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return null;
}

export function parseSwapSizeBytes(value: string): number {
  const match = value.match(/^([0-9]+)([KMG])$/iu);
  if (!match || match[1].length > 8) throw new Error('Swap size must be between 128M and 16G.');
  const amount = Number(match[1]);
  const multiplier = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[2].toUpperCase() as 'K' | 'M' | 'G'];
  const bytes = amount * multiplier;
  if (!Number.isSafeInteger(bytes) || bytes < MIN_SWAP_BYTES || bytes > MAX_SWAP_BYTES) {
    throw new Error('Swap size must be between 128M and 16G.');
  }
  return bytes;
}

export function validateSwapConfig(config: CanvasCliConfig, managedFile = '/swapfile'): void {
  if (parseBoolean(config.swap.enabled) === null) throw new Error('Swap enabled must be true or false.');
  parseSwapSizeBytes(config.swap.size);
  if (config.swap.file !== managedFile) {
    throw new Error(`Canvas-managed swap file path must be ${managedFile}.`);
  }
  if (!Number.isInteger(config.swap.swappiness) || config.swap.swappiness < 0 || config.swap.swappiness > 200) {
    throw new Error('Swap swappiness must be an integer between 0 and 200.');
  }
}

export function isSwapCommand(command: string): boolean {
  return ['swap', 'swap-sync', 'swap-apply', 'swap-enable', 'swap-disable'].includes(command);
}

export class SwapManager {
  private readonly testRoot: string | null;
  private readonly paths: SwapPaths;
  private readonly diskHeadroomBytes: number;

  constructor(
    private readonly runner: CommandRunner,
    private readonly context: RuntimeContext,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.testRoot = env.CANVAS_SWAP_TEST_ROOT ? path.resolve(env.CANVAS_SWAP_TEST_ROOT) : null;
    this.paths = this.testRoot
      ? {
        managedFile: path.join(this.testRoot, 'swapfile'),
        fstab: path.join(this.testRoot, 'fstab'),
        procSwaps: path.join(this.testRoot, 'proc-swaps'),
        runtimeSwappiness: path.join(this.testRoot, 'swappiness'),
        sysctl: path.join(this.testRoot, '90-canvas-notebook-swap.conf'),
        state: path.join(this.testRoot, 'swap.state'),
      }
      : {
        managedFile: '/swapfile',
        fstab: '/etc/fstab',
        procSwaps: '/proc/swaps',
        runtimeSwappiness: '/proc/sys/vm/swappiness',
        sysctl: '/etc/sysctl.d/90-canvas-notebook-swap.conf',
        state: '/var/lib/canvas-notebook/swap.state',
      };
    this.diskHeadroomBytes = this.testRoot ? 0 : 1024 ** 3;
  }

  managedFile(): string {
    return this.paths.managedFile;
  }

  private assertLinux(): void {
    if (this.context.platform !== 'linux') {
      throw new Error('Swap management is only supported on Linux. No host changes were made.');
    }
  }

  private async assertTestRoot(): Promise<void> {
    if (!this.testRoot) return;
    const info = await fs.lstat(this.testRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error('CANVAS_SWAP_TEST_ROOT must be an existing, user-owned directory.');
    }
    const expectedUid = typeof process.getuid === 'function' ? process.getuid() : info.uid;
    if (info.uid !== expectedUid) {
      throw new Error('CANVAS_SWAP_TEST_ROOT must be an existing, user-owned directory.');
    }
  }

  private async preflight(config: CanvasCliConfig): Promise<void> {
    this.assertLinux();
    await this.assertTestRoot();
    validateSwapConfig(config, this.paths.managedFile);
    await this.readRegularFile(this.paths.procSwaps, 'active swap state');
    await this.readFstab();
    await this.assertSafeOptionalPath(this.paths.state, 'Canvas swap ownership state');
  }

  private async lstatOptional(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
    return fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  }

  private async pathExists(filePath: string): Promise<boolean> {
    return (await this.lstatOptional(filePath)) !== null;
  }

  private async assertSafeOptionalPath(filePath: string, label: string): Promise<void> {
    const info = await this.lstatOptional(filePath);
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error(`Unsafe ${label} path: ${filePath}`);
  }

  private async readRegularFile(filePath: string, label: string): Promise<string> {
    const info = await this.lstatOptional(filePath);
    if (!info || !info.isFile() || info.isSymbolicLink()) throw new Error(`Cannot safely read ${label} from ${filePath}`);
    return fs.readFile(filePath, 'utf8');
  }

  private async readFstab(): Promise<string> {
    const info = await this.lstatOptional(this.paths.fstab);
    if (!info) return '';
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Cannot safely read swap persistence from ${this.paths.fstab}`);
    }
    return fs.readFile(this.paths.fstab, 'utf8');
  }

  private fstabMatches(content: string, file: string, managed: boolean | null): boolean {
    return content.split(/\r?\n/u).some((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return false;
      const fields = trimmed.split(/\s+/u);
      if (fields[0] !== file || fields[2] !== 'swap') return false;
      const hasMarker = trimmed.endsWith(MANAGED_FSTAB_MARKER);
      return managed === null || hasMarker === managed;
    });
  }

  private async activeSwapFiles(): Promise<Set<string>> {
    const content = await this.readRegularFile(this.paths.procSwaps, 'active swap state');
    return new Set(content.split(/\r?\n/u).slice(1).map((line) => line.trim().split(/\s+/u)[0]).filter(Boolean));
  }

  private async fileIsSafe(filePath: string): Promise<boolean> {
    const info = await this.lstatOptional(filePath);
    return Boolean(info?.isFile() && !info.isSymbolicLink() && info.nlink === 1);
  }

  private async fileIdentity(filePath: string): Promise<string> {
    if (!await this.fileIsSafe(filePath)) throw new Error(`Unsafe Canvas swap path: ${filePath}`);
    const info = await fs.stat(filePath);
    return `${info.dev}:${info.ino}`;
  }

  private async readState(): Promise<SwapState | null> {
    const info = await this.lstatOptional(this.paths.state);
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe Canvas swap ownership state path: ${this.paths.state}`);
    const [identity, mode] = (await fs.readFile(this.paths.state, 'utf8')).trim().split(/\s+/u);
    if (!identity || (mode !== 'normal' && mode !== 'secure')) {
      throw new Error('Canvas swap transaction is incomplete');
    }
    return { identity, mode };
  }

  private async stateMatches(filePath: string, suppliedState?: SwapState | null): Promise<boolean> {
    const state = suppliedState === undefined ? await this.readState() : suppliedState;
    return Boolean(state && await this.fileIsSafe(filePath) && state.identity === await this.fileIdentity(filePath));
  }

  private async fileIsManaged(filePath: string, suppliedFstab?: string): Promise<boolean> {
    const fstab = suppliedFstab === undefined ? await this.readFstab() : suppliedFstab;
    return this.fstabMatches(fstab, filePath, true) || await this.stateMatches(filePath);
  }

  private expectedOwner(): { uid: number; gid: number } {
    if (!this.testRoot) return { uid: 0, gid: 0 };
    return {
      uid: typeof process.getuid === 'function' ? process.getuid() : 0,
      gid: typeof process.getgid === 'function' ? process.getgid() : 0,
    };
  }

  private async permissionsAreManaged(filePath: string): Promise<boolean> {
    if (!await this.fileIsSafe(filePath)) return false;
    const info = await fs.stat(filePath);
    const owner = this.expectedOwner();
    return (info.mode & 0o777) === 0o600 && info.uid === owner.uid && info.gid === owner.gid;
  }

  private async runRoot(command: string, args: string[]): Promise<void> {
    const useSudo = !this.testRoot && typeof process.getuid === 'function' && process.getuid() !== 0;
    const result = useSudo
      ? await this.runner.run('sudo', [command, ...args])
      : await this.runner.run(command, args);
    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} failed with status ${result.status}`);
    }
  }

  private async removeFile(filePath: string): Promise<void> {
    if (!await this.pathExists(filePath)) return;
    if (this.testRoot) await fs.rm(filePath);
    else await this.runRoot('rm', ['-f', filePath]);
  }

  private async renameFile(source: string, destination: string): Promise<void> {
    if (this.testRoot) await fs.rename(source, destination);
    else await this.runRoot('mv', ['-f', source, destination]);
  }

  private async atomicWrite(filePath: string, content: string, mode: number): Promise<void> {
    const existing = await this.lstatOptional(filePath);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error(`Unsafe managed file path: ${filePath}`);
    if (this.testRoot) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.canvas-notebook.${process.pid}.${Date.now()}`;
      try {
        await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode });
        await fs.chmod(temporary, mode);
        await fs.rename(temporary, filePath);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
      return;
    }
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-swap-'));
    const local = path.join(temporaryDirectory, 'content');
    const rootTemporary = `${filePath}.canvas-notebook.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
    try {
      await fs.writeFile(local, content, { encoding: 'utf8', mode: 0o600 });
      await this.runRoot('mkdir', ['-p', path.dirname(filePath)]);
      await this.runRoot('install', ['-m', mode.toString(8), local, rootTemporary]);
      await this.runRoot('mv', ['-f', rootTemporary, filePath]);
    } finally {
      await this.runRoot('rm', ['-f', rootTemporary]).catch(() => undefined);
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private async writeState(filePath: string, mode: SwapState['mode'] = 'normal'): Promise<void> {
    await this.atomicWrite(this.paths.state, `${await this.fileIdentity(filePath)} ${mode}\n`, 0o644);
  }

  private async removeState(): Promise<void> {
    await this.assertSafeOptionalPath(this.paths.state, 'Canvas swap ownership state');
    await this.removeFile(this.paths.state);
  }

  private async writeFstab(file: string | null): Promise<void> {
    const current = await this.readFstab();
    const records = current.match(/[^\n]*\n|[^\n]+$/gu) || [];
    let next = records.filter((record) => {
      const trimmed = record.trim();
      const fields = trimmed.split(/\s+/u);
      return !(fields[0] === this.paths.managedFile && fields[2] === 'swap' && trimmed.endsWith(MANAGED_FSTAB_MARKER));
    }).join('');
    if (file) {
      if (next && !next.endsWith('\n')) next += '\n';
      next += `${file} none swap sw 0 0 ${MANAGED_FSTAB_MARKER}\n`;
    }
    const mode = (await this.lstatOptional(this.paths.fstab))?.mode;
    await this.atomicWrite(this.paths.fstab, next, mode ? Number(mode) & 0o777 : 0o644);
  }

  private async runtimeSwappiness(): Promise<number> {
    const direct = await fs.readFile(this.paths.runtimeSwappiness, 'utf8').catch(() => '');
    const value = direct.trim() || (await this.runner.run('sysctl', ['-n', 'vm.swappiness'])).stdout.trim();
    if (!/^\d+$/u.test(value)) throw new Error('Cannot read runtime swap swappiness');
    return Number(value);
  }

  private async sysctlMatches(value: number): Promise<boolean> {
    const info = await this.lstatOptional(this.paths.sysctl);
    if (!info || !info.isFile() || info.isSymbolicLink()) return false;
    return (await fs.readFile(this.paths.sysctl, 'utf8')).replace(/\s/gu, '') === `vm.swappiness=${value}`;
  }

  private async applyPermissions(filePath: string): Promise<void> {
    if (this.testRoot) {
      await fs.chmod(filePath, 0o600);
      return;
    }
    await this.runRoot('chown', ['0:0', filePath]);
    await this.runRoot('chmod', ['600', filePath]);
  }

  private async applySwappiness(value: number): Promise<void> {
    await this.atomicWrite(this.paths.sysctl, `vm.swappiness=${value}\n`, 0o644);
    if (this.testRoot) {
      await fs.writeFile(this.paths.runtimeSwappiness, `${value}\n`, 'utf8');
      return;
    }
    await this.runRoot('sysctl', ['-w', `vm.swappiness=${value}`]);
  }

  private async removeSysctl(): Promise<void> {
    for (const filePath of [this.paths.sysctl, `${this.paths.sysctl}.canvas-disabled`]) {
      await this.assertSafeOptionalPath(filePath, 'Canvas swap sysctl');
      await this.removeFile(filePath);
    }
  }

  private async hasSwapSignature(filePath: string): Promise<boolean> {
    const useSudo = !this.testRoot && typeof process.getuid === 'function' && process.getuid() !== 0;
    const command = useSudo ? 'sudo' : 'blkid';
    const args = useSudo ? ['blkid', '-p', '-s', 'TYPE', '-o', 'value', filePath] : ['-p', '-s', 'TYPE', '-o', 'value', filePath];
    const result = await this.runner.run(command, args);
    return result.status === 0 && result.stdout.trim() === 'swap';
  }

  private async prepareSwapFile(filePath: string, size: string, bytes: number): Promise<string> {
    const staging = `${filePath}.canvas-new`;
    if (await this.pathExists(staging)) throw new Error(`Unsafe leftover Canvas swap staging file: ${staging}`);
    const disk = await fs.statfs(path.dirname(filePath));
    const available = disk.bavail * disk.bsize;
    if (available < bytes + this.diskHeadroomBytes) {
      throw new Error(`Not enough free disk space for swap: need ${bytes + this.diskHeadroomBytes} bytes including headroom, have ${available}`);
    }
    try {
      if (this.testRoot) {
        await fs.writeFile(staging, '', { flag: 'wx', mode: 0o600 });
        await fs.truncate(staging, bytes);
      } else {
        const fallocate = await this.runner.run(
          typeof process.getuid === 'function' && process.getuid() !== 0 ? 'sudo' : 'fallocate',
          typeof process.getuid === 'function' && process.getuid() !== 0
            ? ['fallocate', '-l', size, staging]
            : ['-l', size, staging],
        );
        if (fallocate.status !== 0) {
          await this.runRoot('dd', ['if=/dev/zero', `of=${staging}`, 'bs=1M', `count=${Math.ceil(bytes / 1024 ** 2)}`, 'status=none']);
          await this.runRoot('truncate', ['-s', String(bytes), staging]);
        }
      }
      await this.applyPermissions(staging);
      await this.runRoot('mkswap', [staging]);
      return staging;
    } catch (error) {
      await this.removeFile(staging).catch(() => undefined);
      throw error;
    }
  }

  private async wipeFile(filePath: string): Promise<void> {
    if (!await this.fileIsSafe(filePath)) throw new Error(`Unsafe Canvas swap path: ${filePath}`);
    if ((await this.activeSwapFiles()).has(filePath)) throw new Error(`Refusing to wipe active swap file: ${filePath}`);
    await this.runRoot('shred', ['--force', '--iterations=1', filePath]);
    await this.runRoot('sync', []);
  }

  async journalSecureIntent(filePath: string): Promise<void> {
    this.assertLinux();
    await this.assertTestRoot();
    const state = await this.readState();
    if (state?.mode === 'secure') return;
    for (const candidate of [filePath, `${filePath}.canvas-disabled`, `${filePath}.canvas-backup`, `${filePath}.canvas-new`]) {
      if (await this.stateMatches(candidate, state)) {
        await this.writeState(candidate, 'secure');
        return;
      }
    }
    const fstab = await this.readFstab();
    if (this.fstabMatches(fstab, filePath, true)) {
      for (const candidate of [filePath, `${filePath}.canvas-disabled`, `${filePath}.canvas-backup`, `${filePath}.canvas-new`]) {
        if (await this.fileIsSafe(candidate)) {
          await this.writeState(candidate, 'secure');
          return;
        }
      }
    }
  }

  async status(config: CanvasCliConfig, preferredError: string | null = null): Promise<SwapStatus> {
    this.assertLinux();
    let error = preferredError;
    let active = false;
    let persistent = false;
    let managed = false;
    let fstabManaged = false;
    let actualSizeBytes: number | null = null;
    let runtimeSwappiness = config.swap.swappiness;
    const file = config.swap.file;
    try {
      await this.assertTestRoot();
      validateSwapConfig(config, this.paths.managedFile);
      const activeFiles = await this.activeSwapFiles();
      active = activeFiles.has(file);
      const fstab = await this.readFstab();
      persistent = this.fstabMatches(fstab, file, null);
      fstabManaged = this.fstabMatches(fstab, file, true);
      managed = fstabManaged || await this.stateMatches(file);
      const state = await this.readState();
      if (state) {
        if (state.mode === 'secure') error ??= 'Canvas swap secure cleanup is pending';
        const candidates = [file, `${file}.canvas-disabled`, `${file}.canvas-backup`, `${file}.canvas-new`];
        if (!(await Promise.all(candidates.map((candidate) => this.stateMatches(candidate, state)))).some(Boolean)) {
          error ??= 'Canvas swap transaction is incomplete';
        }
      }
      if (await Promise.all([
        `${file}.canvas-disabled`,
        `${file}.canvas-backup`,
        `${file}.canvas-new`,
        `${this.paths.sysctl}.canvas-disabled`,
      ].map((candidate) => this.pathExists(candidate))).then((values) => values.some(Boolean))) {
        error ??= 'Canvas swap transaction is incomplete';
      }
      if (await this.pathExists(file)) {
        if (!await this.fileIsSafe(file)) error ??= `Unsafe Canvas swap path: ${file}`;
        else {
          actualSizeBytes = (await fs.stat(file)).size;
          if (!managed) error ??= `Unmanaged file occupies Canvas swap path: ${file}`;
          else if (!await this.permissionsAreManaged(file)) error ??= 'Canvas swap file permissions or ownership are not secure';
        }
      }
      if (this.fstabMatches(fstab, file, false)) error ??= `Unmanaged swap entry occupies Canvas swap path: ${file}`;
      else if (active && !managed) error ??= `Unmanaged active swap occupies Canvas swap path: ${file}`;
      await this.assertSafeOptionalPath(this.paths.sysctl, 'Canvas swap sysctl');
      runtimeSwappiness = await this.runtimeSwappiness();
    } catch (statusError) {
      error ??= errorMessage(statusError);
    }

    let inSync = false;
    if (!error) {
      if (config.swap.enabled) {
        inSync = managed && active && persistent && fstabManaged
          && actualSizeBytes === parseSwapSizeBytes(config.swap.size)
          && runtimeSwappiness === config.swap.swappiness
          && await this.permissionsAreManaged(file)
          && await this.sysctlMatches(config.swap.swappiness);
      } else {
        inSync = !active && !persistent && actualSizeBytes === null
          && !await this.pathExists(this.paths.sysctl)
          && !await this.pathExists(`${this.paths.sysctl}.canvas-disabled`);
      }
    }
    return {
      enabled: config.swap.enabled,
      active,
      file,
      activeFile: active ? file : null,
      configuredSize: config.swap.size.toUpperCase(),
      actualSizeBytes,
      persistent,
      swappiness: runtimeSwappiness,
      configuredSwappiness: config.swap.swappiness,
      inSync,
      error,
    };
  }

  private async recoverEnableArtifacts(filePath: string): Promise<void> {
    const fstab = await this.readFstab();
    const state = await this.readState();
    const ownershipEvidence = Boolean(state) || this.fstabMatches(fstab, filePath, true);
    const staging = `${filePath}.canvas-new`;
    if (await this.pathExists(staging)) {
      if (!ownershipEvidence || !await this.fileIsSafe(staging) || (await this.activeSwapFiles()).has(staging)) {
        throw new Error(`Unsafe leftover Canvas swap staging file: ${staging}`);
      }
      await this.removeFile(staging);
      if (await this.fileIsSafe(filePath)) await this.writeState(filePath, state?.mode || 'normal');
    }
    const backup = `${filePath}.canvas-backup`;
    if (await this.pathExists(backup)) {
      if (!ownershipEvidence || !await this.fileIsSafe(backup) || (await this.activeSwapFiles()).has(backup)) {
        throw new Error(`Unsafe leftover Canvas swap staging file: ${backup}`);
      }
      await this.wipeFile(backup);
      await this.removeFile(backup);
      if (await this.fileIsSafe(filePath)) await this.writeState(filePath, state?.mode || 'normal');
    }
  }

  private async restoreTextFile(filePath: string, content: string | null, mode = 0o644): Promise<void> {
    if (content === null) await this.removeFile(filePath);
    else await this.atomicWrite(filePath, content, mode);
  }

  private async enable(config: CanvasCliConfig): Promise<void> {
    const file = config.swap.file;
    const desiredBytes = parseSwapSizeBytes(config.swap.size);
    const state = await this.readState();
    if (state?.mode === 'secure' || await this.pathExists(`${file}.canvas-disabled`) || await this.pathExists(`${this.paths.sysctl}.canvas-disabled`)) {
      await this.disable(config, false);
    }
    await this.recoverEnableArtifacts(file);
    const fstabBefore = await this.readFstab();
    if (this.fstabMatches(fstabBefore, file, false)) throw new Error(`Refusing unmanaged swap entry for Canvas path: ${file}`);
    const sysctlBefore = await fs.readFile(this.paths.sysctl, 'utf8').catch(() => null);
    const runtimeBefore = await this.runtimeSwappiness();
    const wasActive = (await this.activeSwapFiles()).has(file);
    const existed = await this.pathExists(file);
    let backup = '';
    let replacementInstalled = false;
    try {
      let staging = '';
      if (existed) {
        if (!await this.fileIsSafe(file)) throw new Error(`Refusing to replace unsafe swap path: ${file}`);
        if (!await this.fileIsManaged(file, fstabBefore)) throw new Error(`Refusing to replace an unmanaged file: ${file}`);
        await this.writeState(file);
        const actualBytes = (await fs.stat(file)).size;
        if (actualBytes !== desiredBytes || !await this.hasSwapSignature(file)) {
          staging = await this.prepareSwapFile(file, config.swap.size, desiredBytes);
        }
      } else {
        staging = await this.prepareSwapFile(file, config.swap.size, desiredBytes);
      }

      if (wasActive && staging) await this.runRoot('swapoff', [file]);
      if (staging) {
        await this.writeState(staging);
        backup = existed ? `${file}.canvas-backup` : '';
        if (backup) await this.renameFile(file, backup);
        await this.renameFile(staging, file);
        replacementInstalled = true;
        await this.writeState(file);
      }
      await this.applyPermissions(file);
      if (!(await this.activeSwapFiles()).has(file)) await this.runRoot('swapon', [file]);
      await this.applySwappiness(config.swap.swappiness);
      await this.writeFstab(file);
      if (backup && await this.pathExists(backup)) {
        await this.wipeFile(backup);
        await this.removeFile(backup);
      }
      await this.writeState(file);
    } catch (error) {
      if (replacementInstalled) {
        if ((await this.activeSwapFiles().catch(() => new Set<string>())).has(file)) {
          await this.runRoot('swapoff', [file]).catch(() => undefined);
        }
        await this.removeFile(file).catch(() => undefined);
        if (backup && await this.pathExists(backup)) {
          await this.renameFile(backup, file).catch(() => undefined);
          await this.writeState(file).catch(() => undefined);
          if (wasActive) await this.runRoot('swapon', [file]).catch(() => undefined);
        } else {
          await this.removeState().catch(() => undefined);
        }
      } else if (!existed) {
        await this.removeFile(`${file}.canvas-new`).catch(() => undefined);
        await this.removeFile(file).catch(() => undefined);
        await this.removeState().catch(() => undefined);
      }
      await this.restoreTextFile(this.paths.fstab, fstabBefore).catch(() => undefined);
      await this.restoreTextFile(this.paths.sysctl, sysctlBefore).catch(() => undefined);
      if (!this.testRoot) await this.runRoot('sysctl', ['-w', `vm.swappiness=${runtimeBefore}`]).catch(() => undefined);
      else await fs.writeFile(this.paths.runtimeSwappiness, `${runtimeBefore}\n`, 'utf8').catch(() => undefined);
      throw error;
    }
  }

  private async disable(config: CanvasCliConfig, secure: boolean): Promise<void> {
    const file = config.swap.file;
    let state = await this.readState();
    if (state?.mode === 'secure') secure = true;
    const fstabBefore = await this.readFstab();
    if (this.fstabMatches(fstabBefore, file, false)) throw new Error(`Refusing unmanaged swap entry for Canvas path: ${file}`);

    for (const artifact of [`${file}.canvas-new`, `${file}.canvas-backup`]) {
      if (!await this.pathExists(artifact)) continue;
      if (!state || !await this.fileIsSafe(artifact) || (await this.activeSwapFiles()).has(artifact)) {
        throw new Error(`Unsafe leftover Canvas swap staging file: ${artifact}`);
      }
      if (artifact.endsWith('.canvas-backup') || secure) await this.wipeFile(artifact);
      await this.removeFile(artifact);
    }

    const disabled = `${file}.canvas-disabled`;
    let fileBackup = await this.pathExists(disabled) ? disabled : '';
    if (fileBackup && (!await this.fileIsSafe(fileBackup) || !await this.stateMatches(fileBackup, state))) {
      throw new Error(`Unsafe leftover Canvas swap file: ${disabled}`);
    }
    let managed = fileBackup.length > 0 || this.fstabMatches(fstabBefore, file, true);
    if (await this.pathExists(file)) {
      if (!await this.fileIsSafe(file)) throw new Error(`Refusing to modify unsafe swap path: ${file}`);
      if (!await this.fileIsManaged(file, fstabBefore)) throw new Error(`Refusing to remove an unmanaged file: ${file}`);
      managed = true;
      await this.writeState(file, secure ? 'secure' : 'normal');
      state = await this.readState();
    }
    if (!managed) {
      await this.removeSysctl();
      return;
    }

    const sysctlBackup = `${this.paths.sysctl}.canvas-disabled`;
    const wasActive = (await this.activeSwapFiles()).has(file);
    try {
      if (wasActive) await this.runRoot('swapoff', [file]);
      if (await this.pathExists(file)) {
        if (await this.pathExists(disabled)) throw new Error('Conflicting Canvas swap transaction files');
        await this.renameFile(file, disabled);
        fileBackup = disabled;
        await this.writeState(disabled, secure ? 'secure' : 'normal');
      }
      if (await this.pathExists(this.paths.sysctl)) {
        await this.assertSafeOptionalPath(this.paths.sysctl, 'Canvas swap sysctl');
        if (await this.pathExists(sysctlBackup)) throw new Error('Conflicting Canvas swap sysctl transaction files');
        await this.renameFile(this.paths.sysctl, sysctlBackup);
      }
      await this.writeFstab(null);
      if (fileBackup && secure) await this.wipeFile(fileBackup);
      if (fileBackup) await this.removeFile(fileBackup);
      await this.removeSysctl();
      await this.removeState();
    } catch (error) {
      const wipePending = secure && fileBackup.length > 0 && await this.pathExists(fileBackup);
      if (!wipePending) {
        if (await this.pathExists(sysctlBackup) && !await this.pathExists(this.paths.sysctl)) {
          await this.renameFile(sysctlBackup, this.paths.sysctl).catch(() => undefined);
        }
        if (fileBackup && await this.pathExists(fileBackup) && !await this.pathExists(file)) {
          await this.renameFile(fileBackup, file).catch(() => undefined);
          await this.writeState(file, secure ? 'secure' : 'normal').catch(() => undefined);
        }
        await this.restoreTextFile(this.paths.fstab, fstabBefore).catch(() => undefined);
        if (wasActive && await this.pathExists(file)) await this.runRoot('swapon', [file]).catch(() => undefined);
      }
      throw error;
    }
  }

  async reconcile(config: CanvasCliConfig, secure = false): Promise<SwapStatus> {
    await this.preflight(config);
    if (config.swap.enabled) await this.enable(config);
    else await this.disable(config, secure);
    return this.status(config);
  }
}
