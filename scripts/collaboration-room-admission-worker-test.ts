import assert from 'node:assert/strict';

import { admissionDrainTicketForTarget } from '../app/lib/collaboration/room-admission-drain';
import { createCollaborationRoomAdmissionWorker } from '../app/lib/collaboration/room-admission-worker';
import type { CollaborationRoomOwnerFence } from '../app/lib/collaboration/room-owner';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventually(probe: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!probe()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 2_000);
    })]);
  } finally { clearTimeout(timer); }
}

function fixture(documentId: string) {
  const fence: CollaborationRoomOwnerFence = Object.freeze({
    scope: Object.freeze({ documentId, workspaceId: 'worker-space', organizationId: null,
      path: `${documentId}.md`, representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1 }),
    epoch: 3, token: `token-${documentId}`, backendPid: 4321, backendStart: '1727370000.12345',
  });
  const ticket = admissionDrainTicketForTarget('99999999-9999-4999-8999-999999999999', 'b'.repeat(64), {
    document: { ...fence.scope, status: 'active' }, ownerEpoch: fence.epoch, ownerToken: fence.token,
    ownerBackendPid: fence.backendPid, ownerBackendStart: fence.backendStart, documentSequence: 4,
  });
  return { fence, ticket };
}

async function testSerialDedupAndWakeCoalescing() {
  const { fence, ticket } = fixture('serial');
  const entered = deferred();
  const release = deferred();
  let pendingCalls = 0;
  let drainCalls = 0;
  let inFlight = 0;
  let maximumInFlight = 0;
  const ownedFences = [fence];
  const worker = createCollaborationRoomAdmissionWorker({
    pollMs: 1_000,
    getOwnedFences: () => ownedFences,
    pendingDrains: async (fences) => {
      assert.notEqual(fences, ownedFences, 'worker copies the caller-owned fence array');
      assert.equal(Object.isFrozen(fences), true);
      pendingCalls += 1;
      return pendingCalls === 1 ? [ticket, ticket] : [];
    },
    drain: async () => {
      drainCalls += 1;
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      entered.resolve();
      await release.promise;
      inFlight -= 1;
    },
  });
  try {
    await bounded(entered.promise, 'initial worker drain');
    worker.wake();
    worker.wake();
    worker.wake();
    release.resolve();
    await eventually(() => pendingCalls >= 2, 'coalesced worker wake');
    assert.equal(drainCalls, 1, 'duplicate durable tickets drain once per poll');
    assert.equal(maximumInFlight, 1, 'worker never overlaps drain callbacks');
    assert.equal(pendingCalls, 2, 'many wakes during a poll coalesce into one follow-up');
  } finally {
    release.resolve();
    worker.dispose();
  }
}

async function testPeriodicRetryAndDispose() {
  const { fence, ticket } = fixture('retry');
  let drainCalls = 0;
  let errors = 0;
  const worker = createCollaborationRoomAdmissionWorker({
    pollMs: 10,
    getOwnedFences: () => [fence],
    pendingDrains: async () => [ticket],
    drain: async () => {
      drainCalls += 1;
      if (drainCalls === 1) throw new Error('known local pre-release failure');
    },
    onError: () => { errors += 1; },
  });
  await eventually(() => drainCalls >= 2, 'periodic durable drain retry');
  assert.equal(errors, 1);
  worker.dispose();
  const callsAtDispose = drainCalls;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(drainCalls, callsAtDispose, 'dispose cancels future polling without a busy loop');
}

async function main() {
  await testSerialDedupAndWakeCoalescing();
  await testPeriodicRetryAndDispose();
  console.log('collaboration room admission worker tests passed (2 scenarios)');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
