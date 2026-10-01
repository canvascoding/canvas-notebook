import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SpawnCommandRunner } from '../cli/src/core/process';
import { StandaloneUpdater } from '../cli/src/core/standaloneUpdater';
import type { StandaloneReleaseResolver, VerifiedStandaloneRelease } from '../cli/src/core/standaloneUpdateRelease';

async function waitFor(check: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, description);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function main(): Promise<void> {
  const runner = new SpawnCommandRunner();
  const alreadyAborted = AbortSignal.abort();
  await assert.rejects(runner.run(process.execPath, ['-e', 'process.exit(0)'], { signal: alreadyAborted }));
  const terminated = await runner.run(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"]);
  assert.notEqual(terminated.status, 0);
  assert.match(terminated.stderr, /SIGTERM/u);

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-updater-lifecycle-'));
  try {
    const cliPath = path.join(directory, 'canvas-notebook');
    const pidPath = path.join(directory, 'preparing-pid');
    await fs.writeFile(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === 'cli-update') {
  process.on('SIGTERM', () => {});
  fs.writeFileSync(process.env.CANVAS_TEST_PREPARING_PID, String(process.pid));
  setInterval(() => {}, 1000);
} else if (process.argv[2] === 'version') {
  process.stdout.write(JSON.stringify({ appVersion: '2026.9.4', cliVersion: '2026.9.5' }));
} else process.exit(2);
`, { mode: 0o700 });
    const release = {
      architecture: 'amd64',
      cliArtifact: { url: 'https://example.com/verified-cli.tar.gz', sha256: 'b'.repeat(64) },
      signed: { manifest: {
        releaseId: 'release-2026.9.5', version: '2026.9.5', cliVersion: '2026.9.5',
        imageRef: `ghcr.io/canvascoding/canvas-notebook@sha256:${'a'.repeat(64)}`,
        backupRequired: false, minimumVersion: null,
      } },
    } as VerifiedStandaloneRelease;
    const env = { ...process.env, CANVAS_CLI_PATH: cliPath, CANVAS_TEST_PREPARING_PID: pidPath };
    for (const mode of ['cancel', 'timeout'] as const) {
      let executions = 0;
      const updater = new StandaloneUpdater({
        env: { ...env, CANVAS_UPDATER_STATE_DIR: path.join(directory, mode) },
        releaseResolver: { resolve: async () => release } as unknown as StandaloneReleaseResolver,
        currentVersion: async () => ({ appVersion: '2026.9.4', cliVersion: '2026.9.4' }),
        cliPreparationTimeoutMs: mode === 'timeout' ? 250 : 60_000,
        executeUpdate: async () => { executions += 1; return 0; },
      });
      await fs.rm(pidPath, { force: true });
      await updater.initialize();
      const operation = await updater.startUpdate({ channel: 'stable' });
      await waitFor(() => fs.access(pidPath).then(() => true, () => false), 'CLI preparation must start');
      const pid = Number(await fs.readFile(pidPath, 'utf8'));
      if (mode === 'cancel') await updater.cancelUpdate(operation.operationId);
      await waitFor(async () => !updater.busy, 'Updater must release its reservation after termination');
      assert.throws(() => process.kill(pid, 0), /ESRCH/u, 'Stubborn preparation child must be reaped');
      assert.equal(executions, 0, 'Canceled/timed-out preparation must never reach apply');
      const completed = await updater.getOperation(operation.operationId);
      assert.equal(completed?.status, 'failed');
      assert.match(completed?.error || '', mode === 'cancel' ? /cancel/u : /deadline/u);
      const next = await updater.startUpdate({ channel: 'stable' });
      assert.notEqual(next.operationId, operation.operationId);
      await updater.cancelUpdate(next.operationId);
      await waitFor(async () => !updater.busy, 'Next canceled request must also release its reservation');
    }

    const interruptedApply = new StandaloneUpdater({
      env: { ...env, CANVAS_UPDATER_STATE_DIR: path.join(directory, 'interrupted-apply') },
      releaseResolver: { resolve: async () => release } as unknown as StandaloneReleaseResolver,
      currentVersion: async () => ({ appVersion: '2026.9.4', cliVersion: '2026.9.5' }),
      prepareHostCli: async () => undefined,
      executeUpdate: async (operation, onEvent) => {
        await onEvent({
          contractVersion: 1, eventId: crypto.randomUUID(), sequence: 1,
          operationId: operation.operationId, stage: 'container_recreate', status: 'running',
          message: 'Recreating container', occurredAt: new Date().toISOString(),
        });
        throw new Error('CLI process terminated before verification');
      },
    });
    await interruptedApply.initialize();
    const interrupted = await interruptedApply.startUpdate({ channel: 'stable' });
    await waitFor(async () => !interruptedApply.busy, 'Interrupted apply must settle');
    const uncertain = await interruptedApply.getOperation(interrupted.operationId);
    assert.equal(uncertain?.status, 'indeterminate');
    assert.equal(uncertain?.errorCode, 'operation_interrupted');

    if (process.platform !== 'win32') for (const stdio of ['inherit', 'ignore']) {
      const descendantPath = path.join(directory, `descendant-${stdio}-pid`);
      const controller = new AbortController();
      const execution = runner.run(process.execPath, ['-e', `
        const { spawn } = require('node:child_process');
        const fs = require('node:fs');
        ${stdio === 'inherit' ? "process.on('SIGTERM', () => {});" : ''}
        spawn(process.execPath, ['-e', ${JSON.stringify(`process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(descendantPath)}, String(process.pid)); setInterval(() => {}, 1000);`)}], { stdio: '${stdio}' });
        setInterval(() => {}, 1000);
      `], { signal: controller.signal, processGroup: true });
      await waitFor(() => fs.access(descendantPath).then(() => true, () => false), 'Descendant must start');
      const descendantPid = Number(await fs.readFile(descendantPath, 'utf8'));
      controller.abort();
      assert.equal((await execution).status, 130);
      await waitFor(async () => {
        try { process.kill(descendantPid, 0); return false; } catch { return true; }
      }, 'Cancellation must terminate descendants too');
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
  console.log('standalone updater lifecycle tests passed');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
