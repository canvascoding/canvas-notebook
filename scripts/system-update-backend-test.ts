import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { SystemUpdateEvent, SystemUpdateOperation } from '../cli/src/core/systemUpdateContract';
import { resolveSystemUpdateBackend } from '../app/lib/system-updates/backend';
import { ManualSystemUpdateBackend } from '../app/lib/system-updates/manual-backend';
import { ManagedSystemUpdateBackend } from '../app/lib/system-updates/managed-backend';
import { StandaloneSystemUpdateBackend } from '../app/lib/system-updates/standalone-backend';

const operationId = crypto.randomUUID();
const now = '2026-09-04T12:00:00.000Z';
const operation: SystemUpdateOperation = {
  contractVersion: 1,
  operationId,
  status: 'running',
  stage: 'image_pull',
  targetVersion: '2026.9.5',
  targetImageRef: `ghcr.io/canvascoding/canvas-notebook:v2026.9.5@sha256:${'a'.repeat(64)}`,
  currentVersion: '2026.9.4.2',
  startedAt: now,
  updatedAt: now,
  completedAt: null,
  rolledBack: false,
  errorCode: null,
  error: null,
  lastSequence: 1,
};
const updateEvent: SystemUpdateEvent = {
  contractVersion: 1,
  eventId: crypto.randomUUID(),
  sequence: 1,
  operationId,
  stage: 'image_pull',
  status: 'running',
  message: 'Downloading the verified Canvas release.',
  occurredAt: now,
};

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function main(): Promise<void> {
  const socketPath = path.join(os.tmpdir(), `canvas-app-updater-${process.pid}-${crypto.randomBytes(4).toString('hex')}.sock`);
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/v1/availability?channel=stable') {
      sendJson(response, 200, {
        contractVersion: 1,
        mode: 'standalone',
        channel: 'stable',
        currentVersion: '2026.9.4.2',
        updateAvailable: true,
        ready: true,
        reasons: [],
        release: {
          releaseId: 'release-2026.9.5',
          version: '2026.9.5',
          publishedAt: now,
          backupRequired: true,
          releaseNotesUrl: 'https://example.com/releases/2026.9.5',
        },
      });
      return;
    }
    if (request.method === 'POST' && request.url === '/v1/updates') {
      sendJson(response, 202, { operation });
      return;
    }
    if (request.method === 'GET' && request.url === `/v1/operations/${operationId}`) {
      sendJson(response, 200, operation);
      return;
    }
    if (request.method === 'GET' && request.url === `/v1/operations/${operationId}/events?after=0`) {
      sendJson(response, 200, { operation, events: [updateEvent] });
      return;
    }
    if (request.method === 'POST' && request.url === `/v1/operations/${operationId}/status-ticket`) {
      sendJson(response, 201, {
        path: `/__canvas-host/operations/${operationId}/events`,
        ticket: `${'a'.repeat(40)}.${'b'.repeat(43)}`,
        expiresAt: '2026-09-04T12:20:00.000Z',
      });
      return;
    }
    sendJson(response, 404, { error: { code: 'not_found', message: 'Not found.' } });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  try {
    const backend = new StandaloneSystemUpdateBackend({
      ...process.env,
      CANVAS_UPDATER_SOCKET_PATH: socketPath,
    });
    const availability = await backend.getAvailability('stable');
    assert.equal(availability.mode, 'standalone');
    assert.equal(availability.release?.version, '2026.9.5');
    assert.equal(availability.release?.backupRequired, true);

    const started = await backend.startUpdate({ channel: 'stable', expectedReleaseId: 'release-2026.9.5' });
    assert.equal(started.operationId, operationId);
    assert.equal('targetImageRef' in started, false, 'the browser-facing operation must not expose the image reference');

    const loaded = await backend.getOperation(operationId);
    assert.equal(loaded.stage, 'image_pull');
    assert.equal('targetImageRef' in loaded, false);

    const snapshot = await backend.getEvents(operationId, 0);
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.events[0].operationId, operationId);
    assert.equal('targetImageRef' in snapshot.operation, false);
    const statusAccess = await backend.createStatusAccess(operationId);
    assert.equal(statusAccess.path, `/__canvas-host/operations/${operationId}/events`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(socketPath, { force: true });
  }

  const coolify = new ManualSystemUpdateBackend({
    ...process.env,
    COOLIFY_RESOURCE_UUID: 'resource-1',
  });
  const manualAvailability = await coolify.getAvailability('stable');
  assert.equal(manualAvailability.mode, 'manual');
  assert.equal(manualAvailability.platform, 'coolify');
  assert.equal(manualAvailability.updateAvailable, null);
  await assert.rejects(() => coolify.startUpdate({ channel: 'stable' }), /deployment platform/u);

  const compose = new ManualSystemUpdateBackend({
    ...process.env,
    CANVAS_DEPLOYMENT_PLATFORM: 'docker-compose',
  });
  assert.equal((await compose.getAvailability('stable')).platform, 'docker-compose');

  const installer = new ManualSystemUpdateBackend({
    ...process.env,
    CANVAS_DEPLOYMENT_PLATFORM: 'canvas-installer',
  });
  const installerAvailability = await installer.getAvailability('stable');
  assert.equal(installerAvailability.platform, 'canvas-installer');
  assert.deepEqual(installerAvailability.instructions, ['runCliUpdate', 'verifyDeployment']);

  const managedOperation = Object.fromEntries(
    Object.entries(operation).filter(([key]) => key !== 'targetImageRef'),
  );
  const managedToken = 'managed-instance-token';
  let statusPathOverride: string | null = null;
  let redirectRequest = false;
  let receivedRedirect = false;
  let managedBaseUrl = '';
  const ticketExpiry = new Date(Date.now() + 120_000).toISOString();
  const managedRequests: Array<{ authorization?: string; method?: string; url?: string; body?: string }> = [];
  const managedServer = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      managedRequests.push({
        authorization: request.headers.authorization,
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (request.url === '/redirect-target') { receivedRedirect = true; sendJson(response, 200, {}); return; }
      if (redirectRequest) { response.writeHead(302, { Location: '/redirect-target' }); response.end(); return; }
      if (request.method === 'POST' && request.url === `/v1/managed/system-updates/${operationId}/status-ticket`) {
        sendJson(response, 200, { path: statusPathOverride || `${managedBaseUrl}/v1/managed/system-updates/${operationId}/status`,
          ticket: 'read-only-fixture', expiresAt: ticketExpiry, transport: 'snapshot' });
        return;
      }
      if (request.method === 'GET' && request.url === '/v1/managed/system-updates/availability?channel=stable') {
        sendJson(response, 200, {
          contractVersion: 1,
          mode: 'managed',
          platform: 'canvas-installer',
          channel: 'stable',
          currentVersion: '2026.9.4.2',
          updateAvailable: true,
          ready: true,
          reasons: [],
          release: {
            releaseId: crypto.randomUUID(),
            version: '2026.9.5',
            publishedAt: now,
            backupRequired: false,
            releaseNotesUrl: 'https://example.com/releases/2026.9.5',
          },
          instructions: [],
        });
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/managed/system-updates') {
        sendJson(response, 202, { operation: managedOperation });
        return;
      }
      if (request.method === 'GET' && request.url === `/v1/managed/system-updates/${operationId}`) {
        sendJson(response, 200, { operation: managedOperation });
        return;
      }
      if (request.method === 'GET' && request.url === `/v1/managed/system-updates/${operationId}/events?after=0`) {
        sendJson(response, 200, { operation: managedOperation, events: [updateEvent] });
        return;
      }
      sendJson(response, 404, { error: 'Not found.', code: 'not_found' });
    });
  });
  await new Promise<void>((resolve, reject) => {
    managedServer.once('error', reject);
    managedServer.listen(0, '127.0.0.1', resolve);
  });
  const address = managedServer.address();
  assert.ok(address && typeof address === 'object');
  const previousControlPlaneUrl = process.env.CANVAS_CONTROL_PLANE_URL;
  managedBaseUrl = `http://127.0.0.1:${address.port}`;
  process.env.CANVAS_CONTROL_PLANE_URL = managedBaseUrl;
  try {
    const backend = new ManagedSystemUpdateBackend({
      ...process.env,
      CANVAS_INSTANCE_TOKEN: managedToken,
      CANVAS_UPDATE_ALLOW_LOCAL_HTTP: 'true',
    });
    const availability = await backend.getAvailability('stable');
    assert.equal(availability.mode, 'managed');
    assert.equal(availability.ready, true);
    const releaseId = availability.release?.releaseId;
    assert.ok(releaseId);
    const started = await backend.startUpdate({ channel: 'stable', expectedReleaseId: releaseId });
    assert.equal(started.operationId, operationId);
    assert.equal('targetImageRef' in started, false);
    assert.equal((await backend.getOperation(operationId)).stage, 'image_pull');
    assert.equal((await backend.getEvents(operationId, 0)).events.length, 1);
    assert.deepEqual(await backend.createStatusAccess(operationId), {
      path: `${managedBaseUrl}/v1/managed/system-updates/${operationId}/status`, ticket: 'read-only-fixture', expiresAt: ticketExpiry, transport: 'snapshot',
    });
    statusPathOverride = `/v1/managed/system-updates/${operationId}/status`;
    assert.equal((await backend.createStatusAccess(operationId))?.path, `${managedBaseUrl}${statusPathOverride}`);
    for (const path of [
      `https://attacker.example/v1/managed/system-updates/${operationId}/status`,
      `${managedBaseUrl}/v1/managed/system-updates/${crypto.randomUUID()}/status`,
      `${managedBaseUrl}/v1/managed/system-updates/${operationId}/status?redirect=evil`,
    ]) {
      statusPathOverride = path;
      await assert.rejects(() => backend.createStatusAccess(operationId), /status access is invalid/u);
    }
    redirectRequest = true;
    await assert.rejects(() => backend.getOperation(operationId));
    assert.equal(receivedRedirect, false, 'instance tokens must never follow redirects');
    redirectRequest = false;
    assert.ok(managedRequests.every((request) => request.authorization === `Bearer ${managedToken}`));
    const startRequest = managedRequests.find((request) => request.method === 'POST');
    assert.deepEqual(JSON.parse(startRequest?.body || '{}'), { channel: 'stable', expectedReleaseId: releaseId });
  } finally {
    if (previousControlPlaneUrl === undefined) delete process.env.CANVAS_CONTROL_PLANE_URL;
    else process.env.CANVAS_CONTROL_PLANE_URL = previousControlPlaneUrl;
    await new Promise<void>((resolve) => managedServer.close(() => resolve()));
  }

  const missingToken = resolveSystemUpdateBackend({ NODE_ENV: 'test', CANVAS_MANAGED_SERVICES_ENABLED: 'true', CANVAS_STANDALONE_UPDATER_ENABLED: 'true' });
  assert.equal(missingToken.mode, 'managed');
  const missingAvailability = await missingToken.getAvailability('stable');
  assert.equal(missingAvailability.ready, false);
  assert.deepEqual(missingAvailability.reasons, ['managed_configuration_invalid']);
  await assert.rejects(() => missingToken.startUpdate({ channel: 'stable', expectedReleaseId: crypto.randomUUID() }), /CANVAS_INSTANCE_TOKEN/u);
  assert.equal(resolveSystemUpdateBackend({ NODE_ENV: 'test', CANVAS_INSTANCE_TOKEN: managedToken }).mode, 'managed');
  assert.equal(resolveSystemUpdateBackend({ NODE_ENV: 'test', CANVAS_CONTROL_PLANE_URL: 'https://services.example.com' }).mode, 'manual');
  assert.equal(resolveSystemUpdateBackend({ NODE_ENV: 'test', CANVAS_STANDALONE_UPDATER_ENABLED: 'true' }).mode, 'standalone');
  for (const [url, optIn, readyConfiguration] of [
    ['http://host.orb.internal:4001', undefined, false], ['http://host.orb.internal:4001', 'true', true],
    ['http://127.0.0.1:4001', undefined, false], ['http://example.com', 'true', false],
    ['https://user:password@example.com', undefined, false], ['https://example.com/path', undefined, false],
  ] as const) {
    const backend = new ManagedSystemUpdateBackend({ NODE_ENV: 'test', CANVAS_CONTROL_PLANE_URL: url, CANVAS_INSTANCE_TOKEN: managedToken, CANVAS_UPDATE_ALLOW_LOCAL_HTTP: optIn });
    if (!readyConfiguration) assert.equal((await backend.getAvailability('stable')).ready, false);
    else {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => { throw new Error('local configuration accepted'); };
      try { await assert.rejects(() => backend.getAvailability('stable'), /local configuration accepted/u); }
      finally { globalThis.fetch = originalFetch; }
    }
  }
  console.log('system update backend test passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
