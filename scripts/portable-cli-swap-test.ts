import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createDefaultConfig } from '../cli/src/core/config';
import { commandRequiresOperationLock } from '../cli/src/core/operationLock';
import { resolveDefaultPaths } from '../cli/src/core/platform';
import { SwapManager } from '../cli/src/core/swap';
import type { CommandResult, CommandRunner, RunOptions, RuntimeContext } from '../cli/src/core/types';

class SwapTestRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  active = new Set(['/dev/zram0']);
  failNextSwapon = false;
  wipeCount = 0;

  constructor(private readonly procSwaps: string) {}

  private async persistActive(): Promise<void> {
    const rows = [...this.active].map((file) => `${file} file 131068 0 -2`);
    await fs.writeFile(this.procSwaps, `Filename Type Size Used Priority\n${rows.join('\n')}${rows.length ? '\n' : ''}`, 'utf8');
  }

  async run(command: string, args: string[], _options: RunOptions = {}): Promise<CommandResult> {
    this.calls.push({ command, args: [...args] });
    const file = args.at(-1) || '';
    if (command === 'mkswap') return { status: 0, stdout: '', stderr: '' };
    if (command === 'blkid') {
      return await fs.stat(file).then(
        () => ({ status: 0, stdout: 'swap\n', stderr: '' }),
        () => ({ status: 2, stdout: '', stderr: '' }),
      );
    }
    if (command === 'swapon') {
      if (this.failNextSwapon) {
        this.failNextSwapon = false;
        return { status: 9, stdout: '', stderr: 'injected swapon failure' };
      }
      this.active.add(file);
      await this.persistActive();
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'swapoff') {
      this.active.delete(file);
      await this.persistActive();
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'shred') {
      this.wipeCount += 1;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'sync') return { status: 0, stdout: '', stderr: '' };
    return { status: 127, stdout: '', stderr: `Unexpected test command: ${command} ${args.join(' ')}` };
  }
}

async function withTempRoot<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-portable-swap-'));
  try {
    return await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  assert.equal(commandRequiresOperationLock('swap', []), false);
  for (const command of ['swap-sync', 'swap-apply', 'swap-enable', 'swap-disable']) {
    assert.equal(commandRequiresOperationLock(command, []), true, `${command} must use the global operation lock`);
  }

  await withTempRoot(async (root) => {
    const paths = resolveDefaultPaths('macos', {
      HOME: root,
      NODE_ENV: 'test',
      CANVAS_INSTALL_DIR: path.join(root, 'install'),
      CANVAS_DATA_DIR: path.join(root, 'data'),
    });
    const context: RuntimeContext = { platform: 'macos', paths, serviceName: 'canvas-notebook', dockerBin: 'docker' };
    const runner = new SwapTestRunner(path.join(root, 'proc-swaps'));
    const manager = new SwapManager(runner, context, { CANVAS_SWAP_TEST_ROOT: root, NODE_ENV: 'test' });
    const config = createDefaultConfig(paths, 'macos');
    config.swap.file = path.join(root, 'swapfile');
    await assert.rejects(() => manager.status(config), /only supported on Linux/u);
    assert.equal(runner.calls.length, 0, 'unsupported platforms must not execute host commands');
    assert.deepEqual(await fs.readdir(root), [], 'unsupported platforms must not create files');
  });

  await withTempRoot(async (root) => {
    const procSwaps = path.join(root, 'proc-swaps');
    await fs.writeFile(procSwaps, 'Filename Type Size Used Priority\n/dev/zram0 file 131068 0 -2\n', 'utf8');
    await fs.writeFile(path.join(root, 'fstab'), '# portable swap test\n', 'utf8');
    await fs.writeFile(path.join(root, 'swappiness'), '20\n', 'utf8');

    const paths = resolveDefaultPaths('linux', {
      HOME: root,
      NODE_ENV: 'test',
      CANVAS_INSTALL_DIR: path.join(root, 'install'),
      CANVAS_DATA_DIR: path.join(root, 'data'),
    });
    const context: RuntimeContext = { platform: 'linux', paths, serviceName: 'canvas-notebook', dockerBin: 'docker' };
    const runner = new SwapTestRunner(procSwaps);
    const manager = new SwapManager(runner, context, { CANVAS_SWAP_TEST_ROOT: root, NODE_ENV: 'test' });
    const config = createDefaultConfig(paths, 'linux');
    config.swap.file = path.join(root, 'swapfile');
    config.swap.size = '128M';
    config.swap.swappiness = 10;

    const initiallyDisabled = await manager.status(config);
    assert.equal(initiallyDisabled.inSync, true);
    assert.equal(initiallyDisabled.swappiness, 20);

    config.swap.enabled = true;
    const enabled = await manager.reconcile(config);
    assert.deepEqual({ active: enabled.active, persistent: enabled.persistent, inSync: enabled.inSync, error: enabled.error }, {
      active: true,
      persistent: true,
      inSync: true,
      error: null,
    });
    assert.equal(enabled.actualSizeBytes, 128 * 1024 * 1024);
    assert.equal((await fs.stat(config.swap.file)).mode & 0o777, 0o600);
    assert.match(await fs.readFile(path.join(root, 'fstab'), 'utf8'), /# canvas-notebook swap/u);
    assert.equal(runner.active.has('/dev/zram0'), true, 'foreign swap must remain active');

    await fs.chmod(config.swap.file, 0o644);
    assert.match((await manager.status(config)).error || '', /permissions or ownership/u);
    assert.equal((await manager.reconcile(config)).inSync, true);

    await fs.writeFile(`${config.swap.file}.canvas-new`, '', { mode: 0o600 });
    await fs.truncate(`${config.swap.file}.canvas-new`, 256 * 1024 * 1024);
    assert.equal((await manager.status(config)).error, 'Canvas swap transaction is incomplete');
    assert.equal((await manager.reconcile(config)).inSync, true);
    await assert.rejects(fs.stat(`${config.swap.file}.canvas-new`), /ENOENT/u);

    config.swap.size = '256M';
    runner.failNextSwapon = true;
    await assert.rejects(() => manager.reconcile(config), /injected swapon failure/u);
    assert.equal((await fs.stat(config.swap.file)).size, 128 * 1024 * 1024, 'failed resize must restore the old file');
    assert.equal(runner.active.has(config.swap.file), true, 'failed resize must reactivate the old file');
    assert.equal(await fs.readFile(path.join(root, 'fstab'), 'utf8').then((value) => value.includes('# canvas-notebook swap')), true);

    const resized = await manager.reconcile(config);
    assert.equal(resized.actualSizeBytes, 256 * 1024 * 1024);
    assert.equal(resized.inSync, true);

    config.swap.enabled = false;
    const disabled = await manager.reconcile(config);
    assert.equal(disabled.inSync, true);
    assert.equal(disabled.actualSizeBytes, null);
    assert.equal(runner.active.has('/dev/zram0'), true, 'disabling Canvas swap must preserve foreign swap');

    await fs.writeFile(config.swap.file, '', { mode: 0o600 });
    await fs.truncate(config.swap.file, 128 * 1024 * 1024);
    await assert.rejects(() => manager.reconcile(config), /unmanaged file/u);
    assert.equal((await fs.stat(config.swap.file)).size, 128 * 1024 * 1024);
    await fs.rm(config.swap.file);

    const foreign = path.join(root, 'foreign');
    await fs.writeFile(foreign, 'do not touch\n', 'utf8');
    await fs.symlink(foreign, config.swap.file);
    await assert.rejects(() => manager.reconcile(config), /unsafe swap path/iu);
    assert.equal(await fs.readFile(foreign, 'utf8'), 'do not touch\n');
    await fs.rm(config.swap.file);

    config.swap.enabled = true;
    config.swap.size = '128M';
    await manager.reconcile(config);
    await manager.journalSecureIntent(config.swap.file);
    config.swap.enabled = false;
    const securelyDisabled = await manager.reconcile(config, true);
    assert.equal(securelyDisabled.inSync, true);
    assert.equal(runner.wipeCount > 0, true, 'secure disable must invoke the wipe operation');
    assert.equal(runner.active.has('/dev/zram0'), true);
  });

  console.log('portable-cli-swap-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
