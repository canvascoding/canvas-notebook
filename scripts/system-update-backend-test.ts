import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { SystemUpdateEvent, SystemUpdateOperation } from '../cli/src/core/systemUpdateContract';
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

  const managedOperation = Object.fromEntries(
    Object.entries(operation).filter(([key]) => key !== 'targetImageRef'),
  );
  const managedToken = 'managed-instance-token';
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
      if (request.method === 'GET' && request.url === '/v1/managed-system-updates/availability?channel=stable') {
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
      if (request.method === 'POST' && request.url === '/v1/managed-system-updates') {
        sendJson(response, 202, { operation: managedOperation });
        return;
      }
      if (request.method === 'GET' && request.url === `/v1/managed-system-updates/${operationId}`) {
        sendJson(response, 200, { operation: managedOperation });
        return;
      }
      if (request.method === 'GET' && request.url === `/v1/managed-system-updates/${operationId}/events?after=0`) {
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
  process.env.CANVAS_CONTROL_PLANE_URL = `http://127.0.0.1:${address.port}`;
  try {
    const backend = new ManagedSystemUpdateBackend({
      ...process.env,
      CANVAS_INSTANCE_TOKEN: managedToken,
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
    assert.equal(await backend.createStatusAccess(operationId), null);
    assert.ok(managedRequests.every((request) => request.authorization === `Bearer ${managedToken}`));
    const startRequest = managedRequests.find((request) => request.method === 'POST');
    assert.deepEqual(JSON.parse(startRequest?.body || '{}'), { channel: 'stable', expectedReleaseId: releaseId });
  } finally {
    if (previousControlPlaneUrl === undefined) delete process.env.CANVAS_CONTROL_PLANE_URL;
    else process.env.CANVAS_CONTROL_PLANE_URL = previousControlPlaneUrl;
    await new Promise<void>((resolve) => managedServer.close(() => resolve()));
  }

  console.log('system update backend test passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
