import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  acquireOperationLock,
  commandRequiresOperationLock,
  parseOperationLockTimeout,
} from '../cli/src/core/operationLock';
import type { RuntimeContext } from '../cli/src/core/types';

async function waitFor(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await fs.access(filePath).then(() => true, () => false)) return;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<{ code: number; stderr: string }> {
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 0, stderr }));
  });
}

async function main(): Promise<void> {
const root = path.resolve(__dirname, '..');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-operation-lock-'));
const installDir = path.join(tempRoot, 'install');
const lockPath = path.join(installDir, '.canvas-notebook-operation.lock');
const context: RuntimeContext = {
  platform: 'linux',
  serviceName: 'canvas-notebook',
  dockerBin: 'docker',
  paths: {
    installDir,
    dataDir: path.join(tempRoot, 'data'),
    configFile: path.join(installDir, 'canvas-notebook-config.json'),
    composeFile: path.join(installDir, 'canvas-notebook-compose.yaml'),
    containerEnvFile: path.join(installDir, 'canvas-notebook.env'),
    composeEnvFile: path.join(installDir, '.env'),
    logFile: path.join(tempRoot, 'manager.log'),
  },
};
const outputLib = path.join(root, 'install/lib/shared/output.sh');
const utilsLib = path.join(root, 'install/lib/shared/utils.sh');
const configLib = path.join(root, 'install/lib/shared/config_json.sh');
const shellAcquire = `
set -euo pipefail
. "$1"
. "$2"
. "$3"
INSTALL_DIR="$4"
CANVAS_OPERATION_LOCK_PATH="$5"
CANVAS_OPERATION_LOCK_TIMEOUT="$6"
CANVAS_CONFIG_FILE_OWNER="$(id -u):$(id -g)"
canvas_operation_lock_acquire test
if [[ -n "$7" ]]; then touch "$7"; fi
if [[ "$8" != "0" ]]; then sleep "$8"; fi
`;

try {
  const shellAcquirePath = path.join(tempRoot, 'shell-acquire.sh');
  await fs.mkdir(installDir, { recursive: true });
  await fs.writeFile(shellAcquirePath, shellAcquire, { mode: 0o700 });
  assert.equal(parseOperationLockTimeout({ CANVAS_OPERATION_LOCK_TIMEOUT: '7' }), 7);
  assert.throws(() => parseOperationLockTimeout({ CANVAS_OPERATION_LOCK_TIMEOUT: '0' }), /1 to 7200/u);
  assert.equal(commandRequiresOperationLock('update', []), true);
  assert.equal(commandRequiresOperationLock('cli-update', []), true);
  assert.equal(commandRequiresOperationLock('env', ['--render']), true);
  assert.equal(commandRequiresOperationLock('env', ['--sync']), true);
  assert.equal(commandRequiresOperationLock('admin', ['reset-password']), true);

  const shellReady = path.join(tempRoot, 'shell-ready');
  const shellHolder = spawn('bash', [
    shellAcquirePath, outputLib, utilsLib, configLib, installDir, lockPath, '5', shellReady, '3',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  await waitFor(shellReady);
  await assert.rejects(
    acquireOperationLock(context, 'portable-blocked', {
      CANVAS_OPERATION_LOCK_PATH: lockPath,
      CANVAS_OPERATION_LOCK_TIMEOUT: '1',
    }),
    /lock wait exceeded 1s/u,
  );
  assert.equal((await waitForChild(shellHolder)).code, 0);

  const portableLease = await acquireOperationLock(context, 'portable-holder', {
    CANVAS_OPERATION_LOCK_PATH: lockPath,
    CANVAS_OPERATION_LOCK_TIMEOUT: '2',
  });
  const shellBlocked = spawn('bash', [
    shellAcquirePath, outputLib, utilsLib, configLib, installDir, lockPath, '1', '', '0',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const blockedResult = await waitForChild(shellBlocked);
  assert.notEqual(blockedResult.code, 0);
  assert.match(blockedResult.stderr, /lock wait exceeded 1s/u);
  await portableLease.release();

  const borrowedLease = await acquireOperationLock(context, 'borrow-parent', {
    CANVAS_OPERATION_LOCK_PATH: lockPath,
    CANVAS_OPERATION_LOCK_TIMEOUT: '2',
  });
  const borrowedOwner = JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')) as { nonce: string };
  const borrowScript = `
set -euo pipefail
. "$1"
. "$2"
. "$3"
INSTALL_DIR="$4"
canvas_operation_lock_acquire borrowed-child
[[ "\${CANVAS_OPERATION_LOCK_BORROWED:-false}" == "true" ]]
`;
  const borrowScriptPath = path.join(tempRoot, 'borrow.sh');
  await fs.writeFile(borrowScriptPath, borrowScript, { mode: 0o700 });
  const borrowedChild = spawn('bash', [borrowScriptPath, outputLib, utilsLib, configLib, installDir], {
    env: {
      ...process.env,
      CANVAS_OPERATION_LOCK_ACQUIRED: 'true',
      CANVAS_OPERATION_LOCK_PATH: lockPath,
      CANVAS_OPERATION_LOCK_NONCE: borrowedOwner.nonce,
      CANVAS_OPERATION_LOCK_INHERIT_TOKEN: borrowedOwner.nonce,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  assert.equal((await waitForChild(borrowedChild)).code, 0);
  assert.equal(await fs.access(lockPath).then(() => true, () => false), true);
  const rejectedBorrow = spawn('bash', [borrowScriptPath, outputLib, utilsLib, configLib, installDir], {
    env: {
      ...process.env,
      CANVAS_OPERATION_LOCK_ACQUIRED: 'true',
      CANVAS_OPERATION_LOCK_PATH: lockPath,
      CANVAS_OPERATION_LOCK_NONCE: borrowedOwner.nonce,
      CANVAS_OPERATION_LOCK_INHERIT_TOKEN: 'invalid-token',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  assert.notEqual((await waitForChild(rejectedBorrow)).code, 0);
  assert.equal(await fs.access(lockPath).then(() => true, () => false), true);
  await borrowedLease.release();

  const killedReady = path.join(tempRoot, 'killed-ready');
  const killedHolder = spawn('bash', [
    shellAcquirePath, outputLib, utilsLib, configLib, installDir, lockPath, '5', killedReady, '30',
  ], { stdio: 'ignore' });
  await waitFor(killedReady);
  killedHolder.kill('SIGKILL');
  await waitForChild(killedHolder);
  const reclaimedAfterKill = await acquireOperationLock(context, 'sigkill-recovery', {
    CANVAS_OPERATION_LOCK_PATH: lockPath,
    CANVAS_OPERATION_LOCK_TIMEOUT: '4',
  });
  await reclaimedAfterKill.release();

  await fs.mkdir(lockPath, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(lockPath, 'owner.json'), '{"version":', { mode: 0o600 });
  const staleTime = new Date(Date.now() - 5000);
  await fs.utimes(lockPath, staleTime, staleTime);
  const recoveredLease = await acquireOperationLock(context, 'stale-recovery', {
    CANVAS_OPERATION_LOCK_PATH: lockPath,
    CANVAS_OPERATION_LOCK_TIMEOUT: '2',
  });
  const ownerMode = (await fs.stat(path.join(lockPath, 'owner.json'))).mode & 0o777;
  assert.equal(ownerMode, 0o600);
  await recoveredLease.release();

  const updateUnit = await fs.readFile(path.join(root, 'install/templates/canvas-notebook-update.service'), 'utf8');
  const serviceUnit = await fs.readFile(path.join(root, 'install/templates/canvas-notebook.service'), 'utf8');
  const shellConfig = await fs.readFile(path.join(root, 'install/lib/shared/config_json.sh'), 'utf8');
  const installer = await fs.readFile(path.join(root, 'install.sh'), 'utf8');
  const systemdInstaller = await fs.readFile(path.join(root, 'install/lib/systemd.sh'), 'utf8');
  const autoUpdateCommands = await fs.readFile(path.join(root, 'install/lib/commands/auto_update.sh'), 'utf8');
  assert.match(updateUnit, /^TimeoutStartSec=120$/mu);
  assert.match(updateUnit, /^ExecStart=.* updater-trigger --channel stable --no-banner$/mu);
  assert.equal(updateUnit.includes(' cli-update '), false);
  assert.match(serviceUnit, /^TimeoutStartSec=10800$/mu);
  assert.equal(updateUnit.includes('TimeoutStartSec=infinity'), false);
  assert.match(shellConfig, /"autoUpdate": \{\s*"enabled": false,/u);
  assert.match(installer, /CANVAS_AUTO_UPDATE_ENABLED="\$\{CANVAS_AUTO_UPDATE_ENABLED:-false\}"/u);
  assert.match(systemdInstaller, /CANVAS_AUTO_UPDATE_ENABLED:-false/u);
  assert.doesNotMatch(systemdInstaller, /CANVAS_AUTO_UPDATE_ENABLED:-true/u);
  assert.match(autoUpdateCommands, /systemctl stop canvas-notebook-update\.service/u);
  assert.match(autoUpdateCommands, /systemctl disable canvas-notebook-update\.service/u);
  assert.match(systemdInstaller, /systemctl stop canvas-notebook-update\.service/u);
  assert.match(systemdInstaller, /systemctl disable canvas-notebook-update\.service/u);

  console.log('cli operation lock tests passed');
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
