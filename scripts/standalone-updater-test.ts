import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  canonicalizeSystemUpdateReleaseManifest,
  SYSTEM_UPDATE_CONTRACT_VERSION,
  type SystemUpdateEvent,
  type SystemUpdateOperation,
  type SystemUpdateReleaseManifest,
} from '../cli/src/core/systemUpdateContract';
import {
  createStandaloneUpdateOperation,
  STANDALONE_UPDATE_MAX_JOURNAL_BYTES,
  STANDALONE_UPDATE_MAX_OPERATIONS,
  StandaloneUpdateJournal,
} from '../cli/src/core/standaloneUpdateJournal';
import { compareCanvasVersions, StandaloneReleaseResolver } from '../cli/src/core/standaloneUpdateRelease';
import {
  createStandaloneUpdaterHttpServer,
  STANDALONE_UPDATER_IDLE_GRACE_MS,
  StandaloneUpdater,
  triggerStandaloneUpdateFromHost,
} from '../cli/src/core/standaloneUpdater';

const digest = 'a'.repeat(64);

async function withTempDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-updater-test-'));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function releaseManifest(): SystemUpdateReleaseManifest {
  return {
    contractVersion: SYSTEM_UPDATE_CONTRACT_VERSION,
    releaseId: 'release-2026.9.5',
    version: '2026.9.5',
    channel: 'stable',
    imageRef: `ghcr.io/canvascoding/canvas-notebook:v2026.9.5@sha256:${digest}`,
    imageDigest: digest,
    cliVersion: '2026.9.5',
    cliArtifacts: [
      { architecture: 'amd64', url: 'https://example.com/canvas-notebook-linux-x64.tar.gz', sha256: 'b'.repeat(64) },
      { architecture: 'arm64', url: 'https://example.com/canvas-notebook-linux-arm64.tar.gz', sha256: 'c'.repeat(64) },
    ],
    minimumVersion: '2026.8.1',
    backupRequired: false,
    releaseNotesUrl: 'https://example.com/releases/2026.9.5',
    publishedAt: '2026-09-04T08:00:00.000Z',
  };
}

async function signedReleaseFixture(directory: string, transform: (manifest: SystemUpdateReleaseManifest) => SystemUpdateReleaseManifest = (value) => value) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const original = releaseManifest();
  const signature = crypto.sign(null, Buffer.from(canonicalizeSystemUpdateReleaseManifest(original), 'utf8'), privateKey).toString('base64');
  const trustStore = path.join(directory, 'update-trust.json');
  await fs.writeFile(trustStore, `${JSON.stringify({
    version: 1,
    keys: [{
      keyId: 'release-key-1',
      algorithm: 'ed25519',
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2027-01-01T00:00:00.000Z',
    }],
  })}\n`, { mode: 0o600 });
  const envelope = { manifest: transform(original), signature: { algorithm: 'ed25519', keyId: 'release-key-1', value: signature } };
  const resolver = new StandaloneReleaseResolver({
    env: {
      NODE_ENV: 'test',
      CANVAS_UPDATE_TRUST_STORE: trustStore,
      CANVAS_UPDATE_MANIFEST_URL: 'https://updates.example.com/{channel}.json',
    },
    now: () => new Date('2026-09-04T10:00:00.000Z'),
    platformArchitecture: 'x64',
    fetch: async () => new Response(JSON.stringify(envelope), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  return { resolver, envelope };
}

function event(operationId: string, sequence: number, stage: SystemUpdateEvent['stage'], status: SystemUpdateEvent['status']): SystemUpdateEvent {
  return {
    contractVersion: SYSTEM_UPDATE_CONTRACT_VERSION,
    eventId: crypto.randomUUID(),
    sequence,
    operationId,
    stage,
    status,
    message: `${stage} ${status}`,
    occurredAt: new Date(Date.parse('2026-09-04T10:00:00.000Z') + sequence * 1000).toISOString(),
  };
}

async function requestJson<T = unknown>(socketPath: string, requestPath: string, options: { method?: string; body?: unknown } = {}) {
  const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), 'utf8');
  return new Promise<{ status: number; body: T }>((resolve, reject) => {
    const request = http.request({
      socketPath,
      path: requestPath,
      method: options.method || 'GET',
      headers: body ? { 'content-type': 'application/json', 'content-length': body.length } : undefined,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        resolve({ status: response.statusCode || 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as T });
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function main(): Promise<void> {
  assert.equal(compareCanvasVersions('2026.9.4', '2026.9.4'), 0);
  assert.equal(compareCanvasVersions('2026.9.4.1', '2026.9.4'), 1);
  assert.equal(compareCanvasVersions('2026.8.31', '2026.9.1'), -1);
  assert.throws(() => compareCanvasVersions('latest', '2026.9.1'), /cannot be compared/u);

  assert.equal(STANDALONE_UPDATE_MAX_OPERATIONS, 20);
  assert.equal(STANDALONE_UPDATE_MAX_JOURNAL_BYTES, 10 * 1024 * 1024);
  assert.equal(STANDALONE_UPDATER_IDLE_GRACE_MS, 10 * 60 * 1000);

  await withTempDirectory(async (directory) => {
    const { resolver } = await signedReleaseFixture(directory);
    const verified = await resolver.resolve('stable');
    assert.equal(verified.signed.manifest.version, '2026.9.5');
    assert.equal(verified.architecture, 'amd64');

    const { resolver: tampered } = await signedReleaseFixture(directory, (manifest) => ({ ...manifest, version: '2026.9.6' }));
    await assert.rejects(() => tampered.resolve('stable'), /signature is invalid/u);

    await fs.chmod(path.join(directory, 'update-trust.json'), 0o666);
    await assert.rejects(() => resolver.resolve('stable'), /must not be group- or world-writable/u);
  });

  await withTempDirectory(async (directory) => {
    const { resolver } = await signedReleaseFixture(directory);
    const updater = new StandaloneUpdater({
      journal: new StandaloneUpdateJournal(path.join(directory, 'journal')),
      releaseResolver: resolver,
      currentVersion: async () => ({ appVersion: '2026.9.5', cliVersion: '2026.9.5' }),
      prepareHostCli: async () => undefined,
      executeUpdate: async () => {
        throw new Error('up-to-date trigger must not execute an update');
      },
    });
    await updater.initialize();
    const socketPath = path.join('/tmp', `canvas-updater-current-${process.pid}-${crypto.randomBytes(4).toString('hex')}.sock`);
    const server = createStandaloneUpdaterHttpServer(updater);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      const result = await triggerStandaloneUpdateFromHost('stable', {
        ...process.env,
        CANVAS_UPDATER_SOCKET_PATH: socketPath,
      });
      assert.deepEqual(result, {
        started: false,
        operationId: null,
        targetVersion: '2026.9.5',
        reason: 'up_to_date',
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(socketPath, { force: true });
    }
  });

  await withTempDirectory(async (directory) => {
    const { resolver } = await signedReleaseFixture(directory);
    const cliPath = path.join(directory, 'fake-canvas-cli');
    const cliLog = path.join(directory, 'cli-update.json');
    await fs.writeFile(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');
if (process.argv[2] === 'cli-update') {
  fs.writeFileSync(process.env.CANVAS_TEST_CLI_LOG, JSON.stringify({
    url: process.env.CANVAS_LINUX_CLI_URL,
    checksum: fs.readFileSync(fileURLToPath(process.env.CANVAS_LINUX_CLI_SHA256_URL), 'utf8'),
    version: process.env.CANVAS_VERSION,
  }));
  process.exit(0);
}
if (process.argv[2] === 'version') {
  process.stdout.write(JSON.stringify({ appVersion: '2026.9.5', cliVersion: '2026.9.5' }));
  process.exit(0);
}
process.exit(2);
`, { mode: 0o700 });
    const updater = new StandaloneUpdater({
      env: {
        ...process.env,
        CANVAS_CLI_PATH: cliPath,
        CANVAS_TEST_CLI_LOG: cliLog,
        CANVAS_UPDATER_STATE_DIR: path.join(directory, 'journal'),
      },
      releaseResolver: resolver,
      currentVersion: async () => ({ appVersion: '2026.9.4', cliVersion: '2026.9.4' }),
      executeUpdate: async (operation, onEvent) => {
        await onEvent(event(operation.operationId, 1, 'completed', 'succeeded'));
        return 0;
      },
    });
    await updater.initialize();
    const started = await updater.startUpdate({ channel: 'stable' });
    let completed = await updater.getOperation(started.operationId);
    for (let attempt = 0; attempt < 100 && completed?.status !== 'succeeded'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed = await updater.getOperation(started.operationId);
    }
    for (let attempt = 0; attempt < 100 && updater.busy; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(completed?.status, 'succeeded', JSON.stringify(completed));
    const invocation = JSON.parse(await fs.readFile(cliLog, 'utf8')) as { url: string; checksum: string; version: string };
    assert.equal(invocation.url, 'https://example.com/canvas-notebook-linux-x64.tar.gz');
    assert.equal(invocation.version, '2026.9.5');
    assert.match(invocation.checksum, new RegExp(`^${'b'.repeat(64)}\\s`, 'u'));
  });

  await withTempDirectory(async (directory) => {
    const journal = new StandaloneUpdateJournal(path.join(directory, 'journal'));
    await journal.initialize();
    const interrupted = createStandaloneUpdateOperation({
      operationId: crypto.randomUUID(),
      targetVersion: '2026.9.5',
      targetImageRef: `ghcr.io/canvascoding/canvas-notebook@sha256:${digest}`,
      currentVersion: '2026.9.4',
    });
    await journal.writeOperation(interrupted);
    const recovered = await journal.recoverInterruptedOperation(new Date('2026-09-04T10:30:00.000Z'));
    assert.equal(recovered?.status, 'indeterminate');
    assert.equal(recovered?.errorCode, 'operation_interrupted');

    for (let index = 0; index < 25; index += 1) {
      const operation = createStandaloneUpdateOperation({
        operationId: crypto.randomUUID(),
        targetVersion: `2026.9.${index + 1}`,
        targetImageRef: `ghcr.io/canvascoding/canvas-notebook@sha256:${digest}`,
        currentVersion: '2026.9.1',
      });
      await journal.writeOperation({
        ...operation,
        status: 'succeeded',
        stage: 'completed',
        startedAt: operation.updatedAt,
        completedAt: operation.updatedAt,
      });
    }
    await journal.rotate();
    assert.ok((await fs.readdir(path.join(directory, 'journal', 'operations'))).length <= STANDALONE_UPDATE_MAX_OPERATIONS);
  });

  await withTempDirectory(async (directory) => {
    const { resolver } = await signedReleaseFixture(directory);
    const journal = new StandaloneUpdateJournal(path.join(directory, 'journal'));
    let releaseExecution: (() => void) | null = null;
    const executionGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
    const updater = new StandaloneUpdater({
      journal,
      releaseResolver: resolver,
      now: () => new Date('2026-09-04T10:00:00.000Z'),
      currentVersion: async () => ({ appVersion: '2026.9.4', cliVersion: '2026.9.4' }),
      prepareHostCli: async () => undefined,
      executeUpdate: async (operation, onEvent) => {
        await executionGate;
        await onEvent(event(operation.operationId, 1, 'request_validation', 'succeeded'));
        await onEvent(event(operation.operationId, 2, 'image_pull', 'running'));
        await onEvent(event(operation.operationId, 3, 'image_pull', 'succeeded'));
        await onEvent(event(operation.operationId, 4, 'health_verification', 'running'));
        await onEvent(event(operation.operationId, 5, 'health_verification', 'succeeded'));
        await onEvent(event(operation.operationId, 6, 'version_verification', 'succeeded'));
        await onEvent(event(operation.operationId, 7, 'completed', 'succeeded'));
        return 0;
      },
    });
    await updater.initialize();
    const socketPath = path.join('/tmp', `canvas-updater-${process.pid}-${crypto.randomBytes(4).toString('hex')}.sock`);
    const server = createStandaloneUpdaterHttpServer(updater);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      const health = await requestJson<{ mode: string }>(socketPath, '/v1/health');
      assert.equal(health.status, 200);
      assert.equal(health.body.mode, 'standalone');

      const availability = await requestJson<{
        updateAvailable: boolean;
        ready: boolean;
        release: { version: string; imageRef?: string };
      }>(socketPath, '/v1/availability?channel=stable');
      assert.equal(availability.status, 200);
      assert.equal(availability.body.updateAvailable, true);
      assert.equal(availability.body.ready, true);
      assert.equal(availability.body.release.version, '2026.9.5');
      assert.equal('imageRef' in availability.body.release, false, 'the browser must not receive the executable image target');

      const started = await requestJson<{ operation: SystemUpdateOperation }>(socketPath, '/v1/updates', {
        method: 'POST',
        body: { channel: 'stable', expectedReleaseId: 'release-2026.9.5' },
      });
      assert.equal(started.status, 202);
      const operationId = started.body.operation.operationId as string;
      assert.match(operationId, /^[0-9a-f-]{36}$/u);

      const conflict = await requestJson<{ error: { code: string } }>(socketPath, '/v1/updates', { method: 'POST', body: { channel: 'stable' } });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.error.code, 'operation_conflict');

      releaseExecution!();
      let operation = started.body.operation;
      for (let attempt = 0; attempt < 100 && operation.status !== 'succeeded'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        operation = (await requestJson<SystemUpdateOperation>(socketPath, `/v1/operations/${operationId}`)).body;
      }
      assert.equal(operation.status, 'succeeded');
      assert.equal(operation.lastSequence, 7);
      for (let attempt = 0; attempt < 100 && updater.busy; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const events = await requestJson<{ events: SystemUpdateEvent[] }>(socketPath, `/v1/operations/${operationId}/events?after=4`);
      assert.deepEqual(events.body.events.map((entry: SystemUpdateEvent) => entry.sequence), [5, 6, 7]);

      const arbitraryImage = await requestJson<{ error: { code: string } }>(socketPath, '/v1/updates', {
        method: 'POST',
        body: { channel: 'stable', image: 'evil.example/image@sha256:deadbeef' },
      });
      assert.equal(arbitraryImage.status, 400);
      assert.equal(arbitraryImage.body.error.code, 'request_invalid');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(socketPath, { force: true });
    }
  });

  await withTempDirectory(async (directory) => {
    const { resolver } = await signedReleaseFixture(directory);
    let executionStarted: (() => void) | null = null;
    const startedExecution = new Promise<void>((resolve) => { executionStarted = resolve; });
    const updater = new StandaloneUpdater({
      journal: new StandaloneUpdateJournal(path.join(directory, 'journal')),
      releaseResolver: resolver,
      currentVersion: async () => ({ appVersion: '2026.9.4', cliVersion: '2026.9.5' }),
      prepareHostCli: async () => undefined,
      executeUpdate: async (_operation, _onEvent, _release, signal) => {
        executionStarted!();
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        return 143;
      },
    });
    await updater.initialize();
    const socketPath = path.join('/tmp', `canvas-updater-cancel-${process.pid}-${crypto.randomBytes(4).toString('hex')}.sock`);
    const server = createStandaloneUpdaterHttpServer(updater);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      const started = await requestJson<{ operation: SystemUpdateOperation }>(socketPath, '/v1/updates', {
        method: 'POST',
        body: { channel: 'stable', expectedReleaseId: 'release-2026.9.5' },
      });
      await startedExecution;
      const operationId = started.body.operation.operationId;
      const canceled = await requestJson<{ operation: SystemUpdateOperation }>(
        socketPath,
        `/v1/operations/${operationId}/cancel`,
        { method: 'POST' },
      );
      assert.equal(canceled.status, 200);
      assert.equal(canceled.body.operation.status, 'failed');
      assert.equal(canceled.body.operation.errorCode, 'operation_interrupted');
      const repeated = await requestJson<{ operation: SystemUpdateOperation }>(
        socketPath,
        `/v1/operations/${operationId}/cancel`,
        { method: 'POST' },
      );
      assert.equal(repeated.status, 200);
      assert.equal(repeated.body.operation.completedAt, canceled.body.operation.completedAt);
      for (let attempt = 0; attempt < 100 && updater.busy; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(updater.busy, false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(socketPath, { force: true });
    }
  });

  await withTempDirectory(async (directory) => {
    const { resolver } = await signedReleaseFixture(directory);
    let applyStarted: (() => void) | null = null;
    let finishExecution: (() => void) | null = null;
    const startedApply = new Promise<void>((resolve) => { applyStarted = resolve; });
    const executionGate = new Promise<void>((resolve) => { finishExecution = resolve; });
    const updater = new StandaloneUpdater({
      journal: new StandaloneUpdateJournal(path.join(directory, 'journal')),
      releaseResolver: resolver,
      currentVersion: async () => ({ appVersion: '2026.9.4', cliVersion: '2026.9.5' }),
      prepareHostCli: async () => undefined,
      executeUpdate: async (operation, onEvent) => {
        await onEvent(event(operation.operationId, 1, 'image_pull', 'running'));
        applyStarted!();
        await executionGate;
        await onEvent(event(operation.operationId, 2, 'completed', 'succeeded'));
        return 0;
      },
    });
    await updater.initialize();
    const socketPath = path.join('/tmp', `canvas-updater-no-cancel-${process.pid}-${crypto.randomBytes(4).toString('hex')}.sock`);
    const server = createStandaloneUpdaterHttpServer(updater);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    try {
      const started = await requestJson<{ operation: SystemUpdateOperation }>(socketPath, '/v1/updates', {
        method: 'POST',
        body: { channel: 'stable', expectedReleaseId: 'release-2026.9.5' },
      });
      await startedApply;
      const blocked = await requestJson<{ error: { code: string } }>(
        socketPath,
        `/v1/operations/${started.body.operation.operationId}/cancel`,
        { method: 'POST' },
      );
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.error.code, 'operation_conflict');
      finishExecution!();
      for (let attempt = 0; attempt < 100 && updater.busy; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal((await updater.getOperation(started.body.operation.operationId))?.status, 'succeeded');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(socketPath, { force: true });
    }
  });

  console.log('standalone-updater-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
