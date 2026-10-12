import assert from 'node:assert/strict';
import { installRichMigrationRuntime, noteRichMigrationWorkerFailure, noteRichMigrationWorkerSuccess,
  richMigrationRuntimeAvailable, richMigrationConnectedClients } from '../app/lib/collaboration/representation-migration-runtime';
import { createCollaborationRoomAdmissionWorker } from '../app/lib/collaboration/room-admission-worker';
import { admissionDrainTicketForTarget } from '../app/lib/collaboration/room-admission-drain';
import type { CollaborationRoomOwnerFence } from '../app/lib/collaboration/room-owner';
import { createMobileCompatibility } from '../app/lib/mobile/compatibility';
import { MOBILE_CHECKPOINT_CAPABILITY, MOBILE_RICH_MIGRATION_CAPABILITY } from '../app/lib/collaboration/representation-migration-contract';

async function eventually(probe: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error('Runtime health polling timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function main() {
  let cleanup = installRichMigrationRuntime(() => 2);
  const capabilities = () => createMobileCompatibility({ rawInstanceId: 'health-instance', instanceName: 'Health',
    serverVersion: 'health-test', deploymentMode: 'managed-single' }).mobileApi.capabilities;
  assert.equal(richMigrationRuntimeAvailable(), false, 'installation cannot advertise an unprobed runtime');
  assert.equal(capabilities().includes(MOBILE_RICH_MIGRATION_CAPABILITY), false);
  assert.equal(richMigrationConnectedClients('doc'), 2);
  noteRichMigrationWorkerSuccess();
  assert.equal(richMigrationRuntimeAvailable(), true);
  assert.equal(capabilities().includes(MOBILE_RICH_MIGRATION_CAPABILITY), true);
  assert.equal(capabilities().includes(MOBILE_CHECKPOINT_CAPABILITY), true);
  const now = Date.now;
  const started = now();
  try { Date.now = () => started + 5_001; assert.equal(richMigrationRuntimeAvailable(), false, 'stalled poller readiness expires'); }
  finally { Date.now = now; }
  noteRichMigrationWorkerFailure();
  assert.equal(richMigrationRuntimeAvailable(), false);
  noteRichMigrationWorkerSuccess();
  assert.equal(richMigrationRuntimeAvailable(), true, 'a successful bounded probe restores transient failure');
  noteRichMigrationWorkerFailure(true);
  noteRichMigrationWorkerSuccess();
  assert.equal(richMigrationRuntimeAvailable(), false, 'terminal owner/protocol failure requires runtime replacement');
  assert.equal(capabilities().includes(MOBILE_RICH_MIGRATION_CAPABILITY), false);
  cleanup();
  cleanup = installRichMigrationRuntime();
  const fence: CollaborationRoomOwnerFence = { scope: { documentId: 'health-doc', workspaceId: 'health-workspace',
    organizationId: null, path: 'Health.md', representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1 },
    epoch: 1, token: 'health-owner', backendPid: 4321, backendStart: '1700000000.12345' };
  const ticket = admissionDrainTicketForTarget('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'b'.repeat(64), {
    document: { ...fence.scope, status: 'active' }, ownerEpoch: 1, ownerToken: fence.token,
    ownerBackendPid: fence.backendPid, ownerBackendStart: fence.backendStart, documentSequence: 1,
  });
  let mode: 'probe_failed' | 'busy' | 'drain_failed' | 'healthy' = 'probe_failed';
  let errors = 0;
  let successes = 0;
  const worker = createCollaborationRoomAdmissionWorker({ pollMs: 10, getOwnedFences: () => [fence],
    pendingDrains: async () => { if (mode === 'probe_failed') throw new Error('temporary database failure'); return [ticket]; },
    drain: async () => {
      if (mode === 'busy') throw Object.assign(new Error('owner currently busy'), { code: 'ROOM_OWNER_BUSY' });
      if (mode === 'drain_failed') throw new Error('unproven drain');
    }, onError: error => {
      errors++;
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ROOM_OWNER_BUSY')) noteRichMigrationWorkerFailure();
    }, onPollSuccess: () => { successes++; noteRichMigrationWorkerSuccess(); },
  });
  try {
    await eventually(() => errors > 0);
    assert.equal(richMigrationRuntimeAvailable(), false, 'failed required-table probe blocks admission');
    mode = 'busy'; worker.wake();
    await eventually(() => successes > 0);
    assert.equal(richMigrationRuntimeAvailable(), true, 'a busy document does not disable the supported runtime');
    mode = 'drain_failed'; worker.wake();
    await eventually(() => !richMigrationRuntimeAvailable());
    mode = 'healthy'; worker.wake();
    await eventually(richMigrationRuntimeAvailable);
  } finally { worker.dispose(); cleanup(); }
  assert.equal(richMigrationRuntimeAvailable(), false);
  console.log('representation runtime: first probe, bounded freshness, transient/fatal errors, busy-owner availability and successful worker recovery passed');
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
