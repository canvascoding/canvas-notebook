import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { ManagedSystemUpdateBackend } from '../app/lib/system-updates/managed-backend';
import { SystemUpdateObservation } from '../app/lib/system-updates/observation';
import { validateSystemUpdateOperationView } from '../app/lib/system-updates/types';

async function main() {
  const source = process.env.CANVAS_CONTROL_PLANE_SOURCE;
  assert.ok(source, 'Set CANVAS_CONTROL_PLANE_SOURCE to the Control Plane checkout to test both actual implementations.');
  const requireControlPlane = createRequire(path.join(path.resolve(source), 'package.json'));
  const load = (relative: string) => import(pathToFileURL(path.join(path.resolve(source), relative)).href);
  process.env.MANAGED_SECRETS_MASTER_KEY = randomBytes(32).toString('hex');
  const { default: Fastify } = await import(pathToFileURL(requireControlPlane.resolve('fastify')).href);
  const { default: cors } = await import(pathToFileURL(requireControlPlane.resolve('@fastify/cors')).href);
  const { default: routes } = await load('apps/api/src/routes/managedSystemUpdates.ts');
  const { managedUpdateOperation, managedUpdateEvent } = await load('apps/api/src/services/managedSystemUpdateContract.ts');
  const { default: jwtAuth } = await load('apps/api/src/plugins/jwtAuth.ts');
  const { default: onboardingGate } = await load('apps/api/src/plugins/onboardingGate.ts');
  const vmId = randomUUID();
  const operationId = randomUUID();
  const releaseId = randomUUID();
  const commandId = randomUUID();
  const token = `ms_${randomBytes(32).toString('hex')}`;
  const origin = 'https://notebook.example.test';
  const now = new Date();
  const item = {
    id: operationId, commandId, initialVersion: '2026.9.16.2', targetVersion: '2026.9.22.3',
    status: 'running', currentStage: 'image_pull', phase: 'notebook_update', startedAt: now,
    updatedAt: now, completedAt: null as Date | null, failureCode: null, error: null,
  };
  const journal = [{
    id: randomUUID(), itemId: operationId, commandId, sequence: 1,
    stage: 'image_pull', status: 'running', message: 'Pulling verified release', occurredAt: now,
    source: 'host_cli', errorCode: null,
  }];
  const requests: string[] = [];
  const snapshot = async (requestedVm: string, requestedId: string, after = 0) => {
    if (requestedVm !== vmId || requestedId !== operationId) return null;
    return { operation: managedUpdateOperation(item, journal.length), events: journal.slice(after).map(managedUpdateEvent) };
  };
  const server = Fastify();
  await server.register(cors, { origin: 'https://panel.example.test', credentials: true });
  await server.register(jwtAuth);
  await server.register(onboardingGate);
  await server.register(routes, { prefix: '/v1', dependencies: {
    validateToken: async (supplied: string, scope: string) => {
      requests.push(scope);
      return supplied === token ? { vmId } : null;
    },
    availability: async () => ({
      contractVersion: 1, mode: 'managed', platform: 'canvas-installer', channel: 'stable',
      currentVersion: item.initialVersion, updateAvailable: true, ready: true, reasons: [], instructions: [],
      release: { releaseId, version: item.targetVersion, publishedAt: now.toISOString(), backupRequired: false, releaseNotesUrl: null },
    }),
    start: async (requestedVm: string, input: { expectedReleaseId: string }) => {
      assert.equal(requestedVm, vmId);
      assert.equal(input.expectedReleaseId, releaseId);
      return managedUpdateOperation(item, journal.length);
    },
    snapshot,
    statusOrigins: async () => [origin],
  } });
  const base = await server.listen({ host: '127.0.0.1', port: 0 });
  try {
    const backend = new ManagedSystemUpdateBackend({ NODE_ENV: 'test', CANVAS_INSTANCE_TOKEN: token, CANVAS_CONTROL_PLANE_URL: base, CANVAS_UPDATE_ALLOW_LOCAL_HTTP: 'true' });
    assert.equal((await backend.getAvailability('stable')).release?.releaseId, releaseId);
    assert.equal((await backend.startUpdate({ channel: 'stable', expectedReleaseId: releaseId })).operationId, operationId);
    assert.ok(requests.includes('system-updates:read'));
    assert.ok(requests.includes('system-updates:start'));
    for (const status of ['queued', 'dispatching', 'running', 'reconnecting', 'verifying', 'succeeded', 'failed', 'indeterminate', 'skipped']) {
      item.status = status;
      item.completedAt = ['succeeded', 'failed', 'indeterminate', 'skipped'].includes(status) ? now : null;
      assert.ok(validateSystemUpdateOperationView(await backend.getOperation(operationId)), `Notebook rejects CP ${status}`);
    }
    item.status = 'running';
    item.completedAt = null;
    const observation = new SystemUpdateObservation(operationId);
    const first = await backend.getEvents(operationId, 0);
    observation.acceptEvents(first.events);
    assert.equal(observation.acceptOperation(first.operation), true);
    assert.equal(observation.cursor, 1);
    assert.equal((await backend.getEvents(operationId, 1)).events.length, 0);
    await assert.rejects(() => backend.getOperation(randomUUID()), /not found/i);

    const access = await backend.createStatusAccess(operationId);
    assert.ok(access && access.transport === 'snapshot');
    const preflight = await fetch(access.path, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    const statusResponse = await fetch(`${access.path}?after=0`, { headers: { Authorization: `Bearer ${access.ticket}`, Origin: origin }, redirect: 'error', credentials: 'omit' });
    assert.equal(statusResponse.status, 200);
    assert.equal(statusResponse.headers.get('access-control-allow-origin'), origin);
    assert.ok(validateSystemUpdateOperationView((await statusResponse.json()).operation));
    const wrongOrigin = await fetch(access.path, { headers: { Authorization: `Bearer ${access.ticket}`, Origin: 'https://unrelated.example.test' } });
    assert.equal(wrongOrigin.status, 403);
    const wrongOperation = await fetch(access.path.replace(operationId, randomUUID()), { headers: { Authorization: `Bearer ${access.ticket}` } });
    assert.equal(wrongOperation.status, 401);
    const mutation = await fetch(`${base}/v1/managed/system-updates`, { method: 'POST', headers: { Authorization: `Bearer ${access.ticket}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'stable', expectedReleaseId: releaseId }) });
    assert.equal(mutation.status, 401);
    console.log('Control Plane real routes/auth hooks and Notebook backend contract integration passed.');
  } finally {
    await server.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
