import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  AutoUpdateManager,
  renderAutoUpdateService,
  renderAutoUpdateTimer,
  validateAutoUpdateSchedule,
} from '../cli/src/core/autoUpdate';
import { createDefaultConfig } from '../cli/src/core/config';
import { commandRequiresOperationLock } from '../cli/src/core/operationLock';
import { resolveDefaultPaths } from '../cli/src/core/platform';
import type { CanvasCliConfig, CommandResult, CommandRunner, RunOptions, RuntimeContext } from '../cli/src/core/types';

class AutoUpdateTestRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; timerContent: string | null }> = [];
  timerState = 'inactive';
  serviceState = 'inactive';
  validationFailure = false;
  failStartOnce = false;

  constructor(private readonly unitRoot: string) {}

  async run(command: string, args: string[], _options: RunOptions = {}): Promise<CommandResult> {
    const timerContent = await fs.readFile(path.join(this.unitRoot, 'canvas-notebook-update.timer'), 'utf8').catch(() => null);
    this.calls.push({ command, args: [...args], timerContent });
    if (command === 'systemd-analyze' && (args[0] === 'calendar' || args[0] === 'verify')) {
      return this.validationFailure
        ? { status: 1, stdout: '', stderr: 'injected unit validation failure' }
        : { status: 0, stdout: 'ok\n', stderr: '' };
    }
    if (command === 'systemctl' && args[0] === '--version') return { status: 0, stdout: 'systemd 999\n', stderr: '' };
    if (command === 'systemctl' && args[0] === 'is-active') {
      const state = args[1]?.endsWith('.timer') ? this.timerState : this.serviceState;
      return { status: state === 'active' ? 0 : 3, stdout: `${state}\n`, stderr: '' };
    }
    if (command === 'systemctl' && args[0] === 'show') return { status: 0, stdout: 'Sat 2026-08-29 04:00:00 CEST\n', stderr: '' };
    if (command === 'systemctl' && args[0] === 'start') {
      if (this.failStartOnce) {
        this.failStartOnce = false;
        return { status: 1, stdout: '', stderr: 'injected start failure' };
      }
      this.timerState = 'active';
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'systemctl' && args[0] === 'restart') {
      this.timerState = 'active';
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'systemctl' && args[0] === 'stop') {
      if (args[1]?.endsWith('.timer')) this.timerState = 'inactive';
      else this.serviceState = 'inactive';
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'systemctl' && ['enable', 'disable', 'reset-failed', 'daemon-reload'].includes(args[0] || '')) {
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 127, stdout: '', stderr: `Unexpected test command: ${command} ${args.join(' ')}` };
  }
}

async function withTempRoot<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-portable-auto-update-'));
  try {
    return await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function createFixture(root: string, platform: RuntimeContext['platform'] = 'linux'): {
  config: CanvasCliConfig;
  context: RuntimeContext;
  runner: AutoUpdateTestRunner;
  manager: AutoUpdateManager;
  unitRoot: string;
} {
  const paths = resolveDefaultPaths(platform, {
    HOME: root,
    NODE_ENV: 'test',
    CANVAS_INSTALL_DIR: path.join(root, 'install'),
    CANVAS_DATA_DIR: path.join(root, 'data'),
  });
  const context: RuntimeContext = { platform, paths, serviceName: 'canvas-notebook', dockerBin: 'docker' };
  const unitRoot = path.join(root, 'systemd');
  const runner = new AutoUpdateTestRunner(unitRoot);
  const manager = new AutoUpdateManager(runner, context, {
    CANVAS_SYSTEMD_TEST_ROOT: unitRoot,
    CANVAS_CLI_PATH: '/usr/local/bin/canvas-notebook',
    NODE_ENV: 'test',
  });
  const config = createDefaultConfig(paths, platform);
  config.image = `ghcr.io/canvascoding/canvas-notebook@sha256:${'a'.repeat(64)}`;
  return { config, context, runner, manager, unitRoot };
}

async function main(): Promise<void> {
  assert.equal(commandRequiresOperationLock('auto-update-status', []), false);
  for (const command of ['auto-update-enable', 'auto-update-disable', 'auto-update-sync']) {
    assert.equal(commandRequiresOperationLock(command, []), true, `${command} must use the global operation lock`);
  }
  assert.equal(validateAutoUpdateSchedule('*-*-* 04:00:00'), '*-*-* 04:00:00');
  assert.throws(() => validateAutoUpdateSchedule('daily'), /Invalid auto-update schedule/u);

  await withTempRoot(async (root) => {
    const { config, manager, runner, unitRoot } = createFixture(root, 'macos');
    await fs.mkdir(unitRoot);
    await assert.rejects(() => manager.status(config), /only supported on Linux systemd hosts/u);
    assert.equal(runner.calls.length, 0);
    assert.deepEqual(await fs.readdir(unitRoot), []);
  });

  await withTempRoot(async (root) => {
    const { config, manager, runner, unitRoot } = createFixture(root);
    await fs.mkdir(unitRoot);
    config.autoUpdate.enabled = true;
    runner.failStartOnce = true;
    const enabled = await manager.apply(config, 'enable');
    assert.equal(enabled.success, true);
    assert.equal(enabled.effectiveEnabled, true);
    assert.equal(enabled.timerActive, true);
    assert.equal(enabled.inSync, true);
    const timerPath = path.join(unitRoot, 'canvas-notebook-update.timer');
    const servicePath = path.join(unitRoot, 'canvas-notebook-update.service');
    assert.equal(await fs.readFile(timerPath, 'utf8'), renderAutoUpdateTimer(config.autoUpdate.schedule));
    assert.equal(await fs.readFile(servicePath, 'utf8'), renderAutoUpdateService('/usr/local/bin/canvas-notebook'));
    assert.equal((await fs.stat(timerPath)).mode & 0o777, 0o644);
    const validation = runner.calls.find((call) => call.command === 'systemd-analyze' && call.args[0] === 'verify');
    assert.ok(validation);
    assert.equal(validation.timerContent, null, 'units must be validated before the live write');
    const verifyIndex = runner.calls.findIndex((call) => call.command === 'systemd-analyze' && call.args[0] === 'verify');
    const reloadIndex = runner.calls.findIndex((call) => call.command === 'systemctl' && call.args[0] === 'daemon-reload');
    assert.ok(verifyIndex >= 0 && reloadIndex > verifyIndex);

    config.autoUpdate.enabled = false;
    const disabled = await manager.apply(config, 'disable');
    assert.equal(disabled.effectiveEnabled, false);
    assert.equal(disabled.timerActive, false);
    assert.equal(disabled.inSync, true);
  });

  await withTempRoot(async (root) => {
    const { config, manager, runner, unitRoot } = createFixture(root);
    await fs.mkdir(unitRoot);
    config.autoUpdate.enabled = true;
    config.env.CANVAS_MANAGED_SERVICES_ENABLED = true;
    await assert.rejects(() => manager.apply(config, 'enable'), /Control Plane handles updates/u);
    assert.deepEqual(await fs.readdir(unitRoot), []);
    runner.timerState = 'active';
    const synchronized = await manager.apply(config, 'sync');
    assert.equal(synchronized.effectiveEnabled, false);
    assert.equal(synchronized.timerActive, false);
    assert.equal(synchronized.managedByControlPlane, true);
  });

  await withTempRoot(async (root) => {
    const { config, manager, unitRoot } = createFixture(root);
    await fs.mkdir(unitRoot);
    config.image = 'ghcr.io/canvascoding/canvas-notebook:latest';
    config.autoUpdate.enabled = true;
    await assert.rejects(() => manager.apply(config, 'enable'), /pinned to a sha256 digest/u);
    const synchronized = await manager.apply(config, 'sync');
    assert.equal(synchronized.effectiveEnabled, false);
  });

  await withTempRoot(async (root) => {
    const { config, manager, runner, unitRoot } = createFixture(root);
    await fs.mkdir(unitRoot);
    const timerPath = path.join(unitRoot, 'canvas-notebook-update.timer');
    const servicePath = path.join(unitRoot, 'canvas-notebook-update.service');
    await fs.writeFile(timerPath, renderAutoUpdateTimer(config.autoUpdate.schedule), 'utf8');
    await fs.writeFile(servicePath, renderAutoUpdateService('/usr/local/bin/canvas-notebook'), 'utf8');
    config.autoUpdate.enabled = true;
    runner.validationFailure = true;
    await assert.rejects(() => manager.apply(config, 'enable'), /injected unit validation failure/u);
    assert.equal(await fs.readFile(timerPath, 'utf8'), renderAutoUpdateTimer(config.autoUpdate.schedule));
    assert.equal(await fs.readFile(servicePath, 'utf8'), renderAutoUpdateService('/usr/local/bin/canvas-notebook'));
    assert.equal(runner.calls.some((call) => call.command === 'systemctl' && call.args[0] === 'daemon-reload'), false);
  });

  await withTempRoot(async (root) => {
    const { config, manager, unitRoot } = createFixture(root);
    await fs.mkdir(unitRoot);
    const foreign = path.join(root, 'foreign-unit');
    await fs.writeFile(foreign, 'do not touch\n', 'utf8');
    await fs.symlink(foreign, path.join(unitRoot, 'canvas-notebook-update.timer'));
    config.autoUpdate.enabled = true;
    await assert.rejects(() => manager.apply(config, 'enable'), /Unsafe systemd unit path/u);
    assert.equal(await fs.readFile(foreign, 'utf8'), 'do not touch\n');
  });

  await withTempRoot(async (root) => {
    const { config, manager, unitRoot } = createFixture(root);
    await fs.mkdir(unitRoot);
    const timerPath = path.join(unitRoot, 'canvas-notebook-update.timer');
    await fs.writeFile(timerPath, '[Timer]\nOnCalendar=daily\n', 'utf8');
    config.autoUpdate.enabled = true;
    await assert.rejects(() => manager.apply(config, 'enable'), /Refusing to overwrite unmanaged systemd unit/u);
    assert.equal(await fs.readFile(timerPath, 'utf8'), '[Timer]\nOnCalendar=daily\n');
  });

  console.log('portable-cli-auto-update-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
