import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isPinnedImageReference } from './config';
import { resolveCliPath } from './cliPath';
import type { CanvasCliConfig, CommandResult, CommandRunner, RuntimeContext } from './types';

const TIMER_UNIT = 'canvas-notebook-update.timer';
const SERVICE_UNIT = 'canvas-notebook-update.service';
const MANAGED_MARKER = '# Managed by Canvas Notebook';

export type AutoUpdateAction = 'enable' | 'disable' | 'sync';

export interface AutoUpdateStatus {
  supported: boolean;
  configuredEnabled: boolean;
  configuredSchedule: string;
  managedByControlPlane: boolean;
  imagePinned: boolean;
  timerUnitInstalled: boolean;
  serviceUnitInstalled: boolean;
  timerActive: boolean;
  serviceState: string;
  nextRun: string;
  inSync: boolean;
  issues: string[];
  error: string | null;
}

export interface AutoUpdateApplyResult extends AutoUpdateStatus {
  success: boolean;
  changed: boolean;
  effectiveEnabled: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Auto-update operation failed.';
}

function controlPlaneManaged(config: CanvasCliConfig): boolean {
  const managed = String(config.env.CANVAS_MANAGED_SERVICES_ENABLED || '').trim().toLowerCase();
  return ['true', '1', 'yes', 'on'].includes(managed) || String(config.env.CANVAS_CONTROL_PLANE_URL || '').trim().length > 0;
}

export function validateAutoUpdateSchedule(schedule: string): string {
  const normalized = schedule.trim();
  if (!normalized || normalized.length > 128 || /[\0\r\n]/u.test(normalized)) {
    throw new Error("Invalid auto-update schedule. Example: '*-*-* 04:00:00'");
  }
  if (!/^[*0-9,./:-]+\s+[*0-9,./:~-]+(?:\s+[A-Za-z/_+-]+)?$/u.test(normalized)) {
    throw new Error(`Invalid auto-update schedule: ${schedule}`);
  }
  return normalized;
}

function systemdQuote(value: string): string {
  if (!value || /[\0\r\n]/u.test(value)) throw new Error('CLI path contains unsupported control characters.');
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

export function renderAutoUpdateTimer(schedule: string): string {
  return `${MANAGED_MARKER}\n[Unit]\nDescription=Canvas Notebook Auto-Update Timer\n\n[Timer]\nOnCalendar=${validateAutoUpdateSchedule(schedule)}\nRandomizedDelaySec=30m\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`;
}

export function renderAutoUpdateService(cliPath: string): string {
  return `${MANAGED_MARKER}\n[Unit]\nDescription=Canvas Notebook Auto-Update\nAfter=docker.service network-online.target\nWants=docker.service network-online.target\n\n[Service]\nType=oneshot\nExecStart=${systemdQuote(cliPath)} update --require-pinned --no-banner\nTimeoutStartSec=10800\n`;
}

function recognizedTimerUnit(content: string): boolean {
  return content.includes(MANAGED_MARKER) ||
    (content.includes('Description=Canvas Notebook Auto-Update Timer') &&
      content.includes('[Timer]') && content.includes('OnCalendar=') && content.includes('WantedBy=timers.target'));
}

function recognizedServiceUnit(content: string): boolean {
  return content.includes(MANAGED_MARKER) ||
    (content.includes('Description=Canvas Notebook Auto-Update') &&
      content.includes('[Service]') && /ExecStart=.*canvas-notebook.* update --require-pinned --no-banner/u.test(content));
}

export function isAutoUpdateCommand(command: string): boolean {
  return command === 'auto-update-status' || command === 'auto-update-enable' ||
    command === 'auto-update-disable' || command === 'auto-update-sync';
}

export class SystemdUnitStore {
  readonly root: string;
  readonly testRoot: boolean;

  constructor(
    private readonly runner: CommandRunner,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.testRoot = Boolean(env.CANVAS_SYSTEMD_TEST_ROOT);
    this.root = this.testRoot ? path.resolve(String(env.CANVAS_SYSTEMD_TEST_ROOT)) : '/etc/systemd/system';
  }

  path(name: string): string {
    if (!/^[a-z0-9][a-z0-9.-]+\.(?:service|timer)$/u.test(name)) throw new Error(`Invalid systemd unit name: ${name}`);
    return path.join(this.root, name);
  }

  async assertSafeRoot(): Promise<void> {
    if (!this.testRoot) return;
    const info = await fs.lstat(this.root);
    const expectedUid = typeof process.getuid === 'function' ? process.getuid() : info.uid;
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== expectedUid) {
      throw new Error('CANVAS_SYSTEMD_TEST_ROOT must be an existing, user-owned directory.');
    }
  }

  private async lstatOptional(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
    return fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  }

  async read(name: string): Promise<string | null> {
    const filePath = this.path(name);
    const info = await this.lstatOptional(filePath);
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe systemd unit path: ${filePath}`);
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (this.testRoot || (error as NodeJS.ErrnoException).code !== 'EACCES') throw error;
      const result = await this.runRoot('cat', [filePath]);
      if (result.status !== 0) throw new Error(result.stderr.trim() || `Unable to read systemd unit: ${filePath}`);
      return result.stdout;
    }
  }

  private async safeRun(command: string, args: string[]): Promise<CommandResult> {
    try {
      return await this.runner.run(command, args);
    } catch (error) {
      return { status: 127, stdout: '', stderr: errorMessage(error) };
    }
  }

  async runRoot(command: string, args: string[]): Promise<CommandResult> {
    const useSudo = !this.testRoot && typeof process.getuid === 'function' && process.getuid() !== 0;
    return useSudo ? this.safeRun('sudo', [command, ...args]) : this.safeRun(command, args);
  }

  async runRootOrThrow(command: string, args: string[]): Promise<CommandResult> {
    const result = await this.runRoot(command, args);
    if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${command} failed with status ${result.status}`);
    return result;
  }

  async write(name: string, content: string, mode = 0o644): Promise<void> {
    const filePath = this.path(name);
    const existing = await this.lstatOptional(filePath);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error(`Unsafe systemd unit path: ${filePath}`);
    if (this.testRoot) {
      const temporary = `${filePath}.canvas-notebook.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
      try {
        await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode });
        await fs.chmod(temporary, mode);
        await fs.rename(temporary, filePath);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
      return;
    }
    const localDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-systemd-'));
    const localFile = path.join(localDirectory, name);
    const rootTemporary = `${filePath}.canvas-notebook.${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
    try {
      await fs.writeFile(localFile, content, { encoding: 'utf8', mode: 0o600 });
      await this.runRootOrThrow('install', ['-m', mode.toString(8), localFile, rootTemporary]);
      await this.runRootOrThrow('mv', ['-f', rootTemporary, filePath]);
    } finally {
      await this.runRoot('rm', ['-f', rootTemporary]);
      await fs.rm(localDirectory, { recursive: true, force: true });
    }
  }

  async remove(name: string): Promise<void> {
    const filePath = this.path(name);
    const existing = await this.lstatOptional(filePath);
    if (!existing) return;
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error(`Unsafe systemd unit path: ${filePath}`);
    if (this.testRoot) await fs.rm(filePath);
    else await this.runRootOrThrow('rm', ['-f', filePath]);
  }

  async restore(name: string, content: string | null): Promise<void> {
    if (content === null) await this.remove(name);
    else await this.write(name, content);
  }
}

export class AutoUpdateManager {
  private readonly units: SystemdUnitStore;

  constructor(
    private readonly runner: CommandRunner,
    private readonly context: RuntimeContext,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.units = new SystemdUnitStore(runner, env);
  }

  private assertSupported(): void {
    if (this.context.platform !== 'linux') {
      throw new Error('Auto-update management is only supported on Linux systemd hosts. No host changes were made.');
    }
  }

  private async safeRun(command: string, args: string[]): Promise<CommandResult> {
    try {
      return await this.runner.run(command, args);
    } catch (error) {
      return { status: 127, stdout: '', stderr: errorMessage(error) };
    }
  }

  private async systemctl(args: string[]): Promise<CommandResult> {
    return this.units.runRoot('systemctl', args);
  }

  private async systemctlOrThrow(args: string[]): Promise<void> {
    const result = await this.systemctl(args);
    if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `systemctl ${args.join(' ')} failed`);
  }

  private async activeState(unit: string): Promise<string> {
    const result = await this.safeRun('systemctl', ['is-active', unit]);
    return result.stdout.trim() || result.stderr.trim() || 'inactive';
  }

  private async validateUnits(timer: string, service: string, schedule: string): Promise<void> {
    const calendar = await this.safeRun('systemd-analyze', ['calendar', schedule]);
    if (calendar.status !== 0) throw new Error(calendar.stderr.trim() || calendar.stdout.trim() || 'Invalid systemd calendar schedule.');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-systemd-verify-'));
    const timerPath = path.join(directory, TIMER_UNIT);
    const servicePath = path.join(directory, SERVICE_UNIT);
    try {
      await Promise.all([
        fs.writeFile(timerPath, timer, { encoding: 'utf8', mode: 0o600 }),
        fs.writeFile(servicePath, service, { encoding: 'utf8', mode: 0o600 }),
      ]);
      const verify = await this.safeRun('systemd-analyze', ['verify', timerPath, servicePath]);
      if (verify.status !== 0) throw new Error(verify.stderr.trim() || verify.stdout.trim() || 'systemd unit validation failed.');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async status(config: CanvasCliConfig, preferredError: string | null = null): Promise<AutoUpdateStatus> {
    this.assertSupported();
    let timerContent: string | null = null;
    let serviceContent: string | null = null;
    let timerState = 'inactive';
    let serviceState = 'inactive';
    let nextRun = '';
    let error = preferredError;
    let systemdAvailable = false;
    let desiredTimer: string | null = null;
    let desiredService: string | null = null;
    const issues: string[] = [];
    const managed = controlPlaneManaged(config);
    const imagePinned = isPinnedImageReference(config.image);
    try {
      await this.units.assertSafeRoot();
      desiredTimer = renderAutoUpdateTimer(config.autoUpdate.schedule);
      desiredService = renderAutoUpdateService(resolveCliPath(this.env));
      const [systemd, nextTimerContent, nextServiceContent, nextTimerState, nextServiceState] = await Promise.all([
        this.safeRun('systemctl', ['--version']),
        this.units.read(TIMER_UNIT),
        this.units.read(SERVICE_UNIT),
        this.activeState(TIMER_UNIT),
        this.activeState(SERVICE_UNIT),
      ]);
      systemdAvailable = systemd.status === 0;
      timerContent = nextTimerContent;
      serviceContent = nextServiceContent;
      timerState = nextTimerState;
      serviceState = nextServiceState;
      if (timerState === 'active') {
        const next = await this.safeRun('systemctl', ['show', TIMER_UNIT, '--property=NextElapseUSecRealtime', '--value']);
        nextRun = next.status === 0 ? next.stdout.trim() : '';
      }
      if (!timerContent) issues.push('timer_unit_missing');
      if (!serviceContent) issues.push('service_unit_missing');
      if (!systemdAvailable) issues.push('systemd_unavailable');
      if (managed) issues.push('managed_mode');
      if (!imagePinned) issues.push('image_not_pinned');
      if (config.autoUpdate.enabled && timerState !== 'active') issues.push('timer_inactive');
      if (!config.autoUpdate.enabled && ['active', 'activating'].includes(timerState)) issues.push('timer_active_while_disabled');
      if (!config.autoUpdate.enabled && ['active', 'activating', 'deactivating'].includes(serviceState)) issues.push('service_active_while_disabled');
      if (timerContent && timerContent !== desiredTimer) issues.push('timer_unit_drift');
      if (serviceContent && serviceContent !== desiredService) issues.push('service_unit_drift');
    } catch (statusError) {
      error ??= errorMessage(statusError);
      issues.push('status_unavailable');
    }
    const effectiveEnabled = config.autoUpdate.enabled && !managed && imagePinned;
    const inSync = !error && systemdAvailable && (effectiveEnabled
      ? timerContent === desiredTimer && serviceContent === desiredService && timerState === 'active'
      : !['active', 'activating'].includes(timerState) && !['active', 'activating', 'deactivating'].includes(serviceState));
    return {
      supported: systemdAvailable,
      configuredEnabled: config.autoUpdate.enabled,
      configuredSchedule: config.autoUpdate.schedule,
      managedByControlPlane: managed,
      imagePinned,
      timerUnitInstalled: timerContent !== null,
      serviceUnitInstalled: serviceContent !== null,
      timerActive: timerState === 'active',
      serviceState,
      nextRun,
      inSync,
      issues: [...new Set(issues)],
      error,
    };
  }

  private async installUnits(config: CanvasCliConfig): Promise<boolean> {
    const timer = renderAutoUpdateTimer(config.autoUpdate.schedule);
    const service = renderAutoUpdateService(resolveCliPath(this.env));
    const [oldTimer, oldService] = await Promise.all([
      this.units.read(TIMER_UNIT),
      this.units.read(SERVICE_UNIT),
    ]);
    if (oldTimer !== null && !recognizedTimerUnit(oldTimer)) {
      throw new Error(`Refusing to overwrite unmanaged systemd unit: ${this.units.path(TIMER_UNIT)}`);
    }
    if (oldService !== null && !recognizedServiceUnit(oldService)) {
      throw new Error(`Refusing to overwrite unmanaged systemd unit: ${this.units.path(SERVICE_UNIT)}`);
    }
    await this.validateUnits(timer, service, config.autoUpdate.schedule);
    const changed = oldTimer !== timer || oldService !== service;
    try {
      if (oldTimer !== timer) await this.units.write(TIMER_UNIT, timer);
      if (oldService !== service) await this.units.write(SERVICE_UNIT, service);
      if (changed) await this.systemctlOrThrow(['daemon-reload']);
      return changed;
    } catch (error) {
      await Promise.all([
        this.units.restore(TIMER_UNIT, oldTimer),
        this.units.restore(SERVICE_UNIT, oldService),
      ]).catch(() => undefined);
      await this.systemctl(['daemon-reload']);
      throw error;
    }
  }

  private async disableUnits(): Promise<boolean> {
    const [timerState, serviceState] = await Promise.all([
      this.activeState(TIMER_UNIT),
      this.activeState(SERVICE_UNIT),
    ]);
    const changed = ['active', 'activating'].includes(timerState) || ['active', 'activating', 'deactivating'].includes(serviceState);
    for (const args of [
      ['stop', TIMER_UNIT],
      ['stop', SERVICE_UNIT],
      ['disable', TIMER_UNIT],
      ['disable', SERVICE_UNIT],
      ['reset-failed', TIMER_UNIT, SERVICE_UNIT],
    ]) await this.systemctl(args);
    return changed;
  }

  async apply(config: CanvasCliConfig, action: AutoUpdateAction): Promise<AutoUpdateApplyResult> {
    this.assertSupported();
    await this.units.assertSafeRoot();
    const managed = controlPlaneManaged(config);
    const pinned = isPinnedImageReference(config.image);
    let effectiveEnabled = action === 'enable' || (action === 'sync' && config.autoUpdate.enabled);
    if (action === 'enable' && managed) throw new Error('Autonomous auto-update cannot be enabled because Control Plane handles updates.');
    if (action === 'enable' && !pinned) throw new Error('Auto-update requires config.image to be pinned to a sha256 digest.');
    if (managed || !pinned) effectiveEnabled = false;
    let changed = false;
    if (effectiveEnabled) {
      changed = await this.installUnits(config);
      try {
        const enable = await this.systemctl(['enable', TIMER_UNIT]);
        if (enable.status !== 0) throw new Error(enable.stderr.trim() || 'Unable to enable auto-update timer.');
        let start = await this.systemctl(['start', TIMER_UNIT]);
        if (start.status !== 0) start = await this.systemctl(['restart', TIMER_UNIT]);
        if (start.status !== 0) throw new Error(start.stderr.trim() || 'Unable to start auto-update timer.');
      } catch (error) {
        await this.disableUnits().catch(() => undefined);
        throw error;
      }
      changed = true;
    } else {
      changed = await this.disableUnits();
    }
    const effectiveConfig = structuredClone(config);
    effectiveConfig.autoUpdate.enabled = effectiveEnabled;
    return {
      ...await this.status(effectiveConfig),
      success: true,
      changed,
      effectiveEnabled,
    };
  }
}
