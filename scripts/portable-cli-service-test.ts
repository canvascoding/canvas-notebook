import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createDefaultConfig } from '../cli/src/core/config';
import { resolveDefaultPaths } from '../cli/src/core/platform';
import { renderLinuxSystemdService, ServiceManager } from '../cli/src/core/service';
import type { CommandResult, CommandRunner, RunOptions, RuntimeContext } from '../cli/src/core/types';

class ServiceTestRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; liveContent: string | null }> = [];
  failStart = false;

  constructor(private readonly servicePath: string) {}

  async run(command: string, args: string[], _options: RunOptions = {}): Promise<CommandResult> {
    const liveContent = await fs.readFile(this.servicePath, 'utf8').catch(() => null);
    this.calls.push({ command, args: [...args], liveContent });
    if (command === 'systemd-analyze' && args[0] === 'verify') return { status: 0, stdout: '', stderr: '' };
    if (command === 'systemctl' && args[0] === 'start' && this.failStart) {
      return { status: 1, stdout: '', stderr: 'injected start failure' };
    }
    if (command === 'systemctl') return { status: args[0] === 'is-active' ? 3 : 0, stdout: 'inactive\n', stderr: '' };
    return { status: 127, stdout: '', stderr: `Unexpected command: ${command}` };
  }
}

async function withFixture(callback: (fixture: {
  root: string;
  servicePath: string;
  manager: ServiceManager;
  runner: ServiceTestRunner;
  config: ReturnType<typeof createDefaultConfig>;
}) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-portable-service-'));
  try {
    const unitRoot = path.join(root, 'systemd');
    await fs.mkdir(unitRoot);
    const paths = resolveDefaultPaths('linux', {
      HOME: root,
      NODE_ENV: 'test',
      CANVAS_INSTALL_DIR: path.join(root, 'install with spaces'),
      CANVAS_DATA_DIR: path.join(root, 'data'),
      CANVAS_MANAGER_LOG_FILE: path.join(root, 'logs', 'manager.log'),
    });
    const context: RuntimeContext = { platform: 'linux', paths, serviceName: 'canvas-notebook', dockerBin: 'docker' };
    const servicePath = path.join(unitRoot, 'canvas-notebook.service');
    const runner = new ServiceTestRunner(servicePath);
    const manager = new ServiceManager(runner, context, {
      CANVAS_SYSTEMD_TEST_ROOT: unitRoot,
      CANVAS_CLI_PATH: '/usr/local/bin/canvas-notebook',
      NODE_ENV: 'test',
    });
    await callback({ root, servicePath, manager, runner, config: createDefaultConfig(paths, 'linux') });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await withFixture(async ({ servicePath, manager, runner, config }) => {
    const result = await manager.install(config);
    assert.match(result, /installed and enabled/u);
    assert.equal(await fs.readFile(servicePath, 'utf8'), renderLinuxSystemdService(config, '/usr/local/bin/canvas-notebook'));
    assert.equal((await fs.stat(servicePath)).mode & 0o777, 0o644);
    const verify = runner.calls.find((call) => call.command === 'systemd-analyze');
    assert.ok(verify);
    assert.equal(verify.liveContent, null, 'service must be validated before the live write');
    const removed = await manager.uninstall(config);
    assert.match(removed, /removed/u);
    await assert.rejects(fs.stat(servicePath), /ENOENT/u);
  });

  await withFixture(async ({ servicePath, manager, config }) => {
    const unmanaged = '[Service]\nExecStart=/bin/false\n';
    await fs.writeFile(servicePath, unmanaged, 'utf8');
    await assert.rejects(() => manager.install(config), /Refusing to overwrite unmanaged systemd unit/u);
    await assert.rejects(() => manager.uninstall(config), /Refusing to remove unmanaged systemd unit/u);
    assert.equal(await fs.readFile(servicePath, 'utf8'), unmanaged);
  });

  await withFixture(async ({ servicePath, manager, runner, config }) => {
    runner.failStart = true;
    await assert.rejects(() => manager.install(config), /injected start failure/u);
    await assert.rejects(fs.stat(servicePath), /ENOENT/u);
    assert.equal(runner.calls.filter((call) => call.command === 'systemctl' && call.args[0] === 'daemon-reload').length, 2);
  });

  console.log('portable-cli-service-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
