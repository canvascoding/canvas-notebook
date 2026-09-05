import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { beginSystemUpdateApply, systemUpdateApplyAcknowledgement } from '../cli/src/core/systemUpdateApplyGate';
import { SystemUpdateEventReporter } from '../cli/src/core/systemUpdateReporter';
import { StandaloneUpdater } from '../cli/src/core/standaloneUpdater';
import { StandaloneUpdateJournal } from '../cli/src/core/standaloneUpdateJournal';
import { StandaloneReleaseResolver, type VerifiedStandaloneRelease } from '../cli/src/core/standaloneUpdateRelease';
import type { SystemUpdateEvent, SystemUpdateOperation } from '../cli/src/core/systemUpdateContract';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const release = {
  signed: { manifest: { releaseId: 'test', version: '2026.9.6', cliVersion: '2026.9.6',
    minimumVersion: null, imageRef: `ghcr.io/canvascoding/canvas-notebook@sha256:${'a'.repeat(64)}`, backupRequired: false } },
} as VerifiedStandaloneRelease;
class Resolver extends StandaloneReleaseResolver {
  async resolve() { return release; }
}

async function waitIdle(updater: StandaloneUpdater) {
  for (let i = 0; i < 200 && updater.busy; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(updater.busy, false);
}

async function testConcurrentCancel(applyFirst: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-cancel-race-'));
  const reachedWrite = deferred();
  const releaseWrite = deferred();
  const execute = deferred();
  const finish = deferred();
  class DelayedJournal extends StandaloneUpdateJournal {
    async writeOperation(operation: SystemUpdateOperation) {
      if ((applyFirst && operation.stage === 'image_pull') || (!applyFirst && operation.errorCode === 'operation_interrupted')) {
        reachedWrite.resolve(); await releaseWrite.promise;
      }
      return super.writeOperation(operation);
    }
  }
  const updater = new StandaloneUpdater({
    journal: new DelayedJournal(root), releaseResolver: new Resolver(),
    currentVersion: async () => ({ appVersion: '2026.9.5', cliVersion: '2026.9.6' }), prepareHostCli: async () => {},
    executeUpdate: async (operation, onEvent) => {
      await execute.promise;
      await onEvent({ contractVersion: 1, operationId: operation.operationId, eventId: crypto.randomUUID(),
        sequence: 1, stage: 'image_pull', status: 'running', message: 'Ready to apply', occurredAt: new Date().toISOString() });
      await finish.promise; return 1;
    },
  });
  try {
    await updater.initialize();
    const operation = await updater.startUpdate({ channel: 'stable' });
    if (applyFirst) execute.resolve();
    else await new Promise((resolve) => setImmediate(resolve));
    const cancel = applyFirst ? reachedWrite.promise.then(() => updater.cancelUpdate(operation.operationId)) : updater.cancelUpdate(operation.operationId);
    const checked = applyFirst ? assert.rejects(cancel, /no longer be canceled/) : cancel.then((value) => assert.equal(value.status, 'failed'));
    await reachedWrite.promise;
    execute.resolve(); releaseWrite.resolve();
    await checked;
    const stored = await updater.getOperation(operation.operationId);
    assert.equal(stored?.status, applyFirst ? 'running' : 'failed');
    finish.resolve(); await waitIdle(updater);
    if (!applyFirst) assert.equal((await updater.getOperation(operation.operationId))?.errorCode, 'operation_interrupted');
  } finally { execute.resolve(); releaseWrite.resolve(); finish.resolve(); await fs.rm(root, { recursive: true, force: true }); }
}

async function main() {
  const input = new PassThrough();
  const reported: SystemUpdateEvent[] = [];
  const reporter = new SystemUpdateEventReporter({ enabled: true, write: (line) => reported.push(JSON.parse(line)) });
  let applied = false;
  const waiting = beginSystemUpdateApply(reporter, { required: true, input }).then(() => { applied = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reported[0].stage, 'image_pull'); assert.equal(applied, false);
  input.end(`${systemUpdateApplyAcknowledgement(reporter.operationId)}\n`);
  await waiting; assert.equal(applied, true);
  await assert.rejects(beginSystemUpdateApply(reporter, { required: true, input: new PassThrough(), timeoutMs: 5 }), /timed out/);
  const disconnected = new PassThrough();
  const rejected = assert.rejects(beginSystemUpdateApply(reporter, { required: true, input: disconnected }), /disconnected/);
  disconnected.end(); await rejected;
  await testConcurrentCancel(true);
  await testConcurrentCancel(false);

  // Exercise the actual child-process transport: ack arrives only after the
  // host callback has saved the apply stage, and self-update stays disabled.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-apply-child-'));
  try {
    const child = path.join(root, 'cli');
    await fs.writeFile(child, `#!/usr/bin/env node
const assert = require('node:assert/strict');
assert.equal(process.env.CANVAS_CLI_SELF_UPDATE, 'false');
assert.equal(process.env.CANVAS_UPDATE_APPLY_HANDSHAKE, '1');
const id = process.argv[process.argv.indexOf('--operation-id') + 1];
function event(sequence, stage, status) { process.stdout.write(JSON.stringify({contractVersion:1,eventId:require('node:crypto').randomUUID(),operationId:id,sequence,stage,status,message:'test',occurredAt:new Date().toISOString()})+'\\n'); }
require('node:readline').createInterface({input:process.stdin}).once('line', line => {
  assert.equal(line, 'canvas-update-apply:'+id);
  event(2,'completed','succeeded');
});
event(1,'image_pull','running');
`, { mode: 0o700 });
    const updater = new StandaloneUpdater({ env: { ...process.env, CANVAS_CLI_PATH: child },
      journal: new StandaloneUpdateJournal(path.join(root, 'journal')), releaseResolver: new Resolver(),
      currentVersion: async () => ({ appVersion: '2026.9.5', cliVersion: '2026.9.6' }), prepareHostCli: async () => {},
    });
    await updater.initialize(); const op = await updater.startUpdate({ channel: 'stable' });
    await waitIdle(updater);
    assert.equal((await updater.getOperation(op.operationId))?.status, 'succeeded');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
  console.log('system-update-apply-gate-test: ok');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
