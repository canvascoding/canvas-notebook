import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createStandaloneUpdaterHttpServer, StandaloneUpdater } from '../cli/src/core/standaloneUpdater';
import { createStandaloneUpdateOperation, StandaloneUpdateJournal } from '../cli/src/core/standaloneUpdateJournal';
import type { StandaloneReleaseResolver, VerifiedStandaloneRelease } from '../cli/src/core/standaloneUpdateRelease';
import type { SystemUpdateOperation } from '../cli/src/core/systemUpdateContract';

async function main(): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-update-idempotency-'));
  const socketPath = path.join('/tmp', `canvas-idempotency-${crypto.randomUUID()}.sock`);
  const requestId = crypto.randomUUID();
  const input = { requestId, channel: 'stable' as const, expectedReleaseId: 'release-2026.9.5' };
  const journal = new StandaloneUpdateJournal(directory);
  const release = { architecture: 'amd64', signed: { manifest: {
    releaseId: input.expectedReleaseId, version: '2026.9.5', cliVersion: '2026.9.5',
    imageRef: `ghcr.io/canvascoding/canvas-notebook@sha256:${'a'.repeat(64)}`, backupRequired: false,
  } } } as VerifiedStandaloneRelease;
  let resolves = 0;
  let executions = 0;
  let complete!: () => void;
  const executionGate = new Promise<void>((resolve) => { complete = resolve; });
  const updater = new StandaloneUpdater({
    journal,
    releaseResolver: { resolve: async () => { resolves += 1; return release; } } as unknown as StandaloneReleaseResolver,
    currentVersion: async () => ({ appVersion: '2026.9.4', cliVersion: '2026.9.5' }),
    prepareHostCli: async () => undefined,
    executeUpdate: async (operation, onEvent) => {
      executions += 1;
      await executionGate;
      await onEvent({ contractVersion: 1, eventId: crypto.randomUUID(), sequence: 1,
        operationId: operation.operationId, stage: 'completed', status: 'succeeded',
        message: 'Verified completion', occurredAt: new Date().toISOString() });
      return 0;
    },
  });
  await updater.initialize();
  const server = createStandaloneUpdaterHttpServer(updater);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const request = (body: unknown) => new Promise<{ status: number; operation?: SystemUpdateOperation; error?: { code: string } }>((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const req = http.request({ socketPath, path: '/v1/updates', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': bytes.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({ status: res.statusCode || 0, ...JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    req.on('error', reject);
    req.end(bytes);
  });
  try {
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(input)));
    assert.ok(responses.every((res) => res.status === 202 && res.operation?.operationId === requestId));
    assert.ok(responses.every((res) => !('startRequest' in res.operation!)), 'Internal request binding must stay private');
    assert.equal(resolves, 1, 'Replay must bypass release/readiness checks');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(executions, 1, 'Parallel keyed starts must execute once');
    assert.equal((await request({ ...input, channel: 'beta' })).error?.code, 'request_id_conflict');
    assert.equal((await request({ ...input, expectedReleaseId: 'other-release' })).status, 409);
    assert.equal((await request({ ...input, requestId: crypto.randomUUID() })).status, 409);
    assert.equal((await request({ ...input, requestId: 'invalid' })).status, 400);
    complete();
    const deadline = Date.now() + 5_000;
    while (updater.busy && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(updater.busy, false);
    assert.equal((await request(input)).operation?.status, 'succeeded');
    assert.equal(executions, 1);

    const restarted = new StandaloneUpdater({ journal,
      releaseResolver: { resolve: async () => { throw new Error('Replay must not fetch another release'); } } as unknown as StandaloneReleaseResolver });
    await restarted.initialize();
    assert.equal((await restarted.startUpdate(input)).status, 'succeeded');

    const interruptedId = crypto.randomUUID();
    await journal.writeOperation({ ...createStandaloneUpdateOperation({
      operationId: interruptedId, targetVersion: '2026.9.5', currentVersion: '2026.9.4',
      targetImageRef: release.signed.manifest.imageRef,
    }), startRequest: { channel: input.channel, expectedReleaseId: input.expectedReleaseId } });
    const recovered = new StandaloneUpdater({ journal });
    await recovered.initialize();
    const replay = await recovered.startUpdate({ ...input, requestId: interruptedId });
    assert.equal(replay.status, 'indeterminate', 'Restart must preserve request binding and never restart interrupted apply');
    assert.equal(replay.operationId, interruptedId);

    const orphanId = crypto.randomUUID();
    await fs.writeFile(path.join(directory, 'operations', `${orphanId}.json`), JSON.stringify({
      ...createStandaloneUpdateOperation({ operationId: orphanId, targetVersion: '2026.9.5',
        currentVersion: '2026.9.4', targetImageRef: release.signed.manifest.imageRef }),
      startRequest: { channel: input.channel, expectedReleaseId: input.expectedReleaseId },
    }));
    assert.equal((await recovered.startUpdate({ ...input, requestId: orphanId })).status, 'indeterminate');

    const failingJournal = new StandaloneUpdateJournal(path.join(directory, 'pointer-failure'));
    const failingUpdater = new StandaloneUpdater({ journal: failingJournal,
      releaseResolver: { resolve: async () => release } as unknown as StandaloneReleaseResolver,
      currentVersion: async () => ({ appVersion: '2026.9.4', cliVersion: '2026.9.5' }),
      prepareHostCli: async () => undefined, executeUpdate: async () => 1,
    });
    await failingUpdater.initialize();
    const injected = failingJournal as unknown as { writeJsonAtomically: (file: string, value: unknown) => Promise<void> };
    const write = injected.writeJsonAtomically.bind(failingJournal);
    let failPointer = true;
    injected.writeJsonAtomically = async (file, value) => {
      if (failPointer && file.endsWith('/current-operation.json')) throw new Error('Injected pointer write failure');
      return write(file, value);
    };
    const freshId = crypto.randomUUID();
    await assert.rejects(failingUpdater.startUpdate({ ...input, requestId: freshId }), /pointer write failure/u);
    assert.equal(await failingJournal.readOperation(freshId), null, 'Failed pointer write must not publish an unscheduled receipt');
    failPointer = false;
    assert.equal((await failingUpdater.startUpdate({ ...input, requestId: freshId })).operationId, freshId);
    while (failingUpdater.busy) await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    complete();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(socketPath, { force: true });
    await fs.rm(directory, { recursive: true, force: true });
  }
  console.log('standalone updater idempotency tests passed');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
