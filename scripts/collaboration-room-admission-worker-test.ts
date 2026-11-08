import assert from 'node:assert/strict';
import { mock } from 'node:test';

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

async function testIdleBackoffRetainsBoundedDurableFallback() {
  const { fence, ticket } = fixture('idle');
  let calls = 0, drains = 0, errors = 0;
  let needsDrain = false, failNext = false;
  mock.timers.enable({ apis: ['setTimeout'] });
  const advance = async (milliseconds: number) => {
    mock.timers.tick(milliseconds);
    // The real worker awaits IO and drains before scheduling its next timer.
    for (let index = 0; index < 20; index++) await Promise.resolve();
  };
  const worker = createCollaborationRoomAdmissionWorker({
    pollMs: 250,
    getOwnedFences: () => [fence],
    pendingDrains: async () => {
      calls++;
      if (failNext) { failNext = false; throw new Error('owned poll failure'); }
      return needsDrain ? [ticket] : [];
    },
    drain: async () => { drains++; needsDrain = false; },
    onError: () => { errors++; },
  });
  try {
    await advance(0);
    assert.equal(calls, 1);
    await advance(499);
    assert.equal(calls, 1, 'An empty 250 ms poll backs off instead of querying every 250 ms.');
    await advance(1);
    assert.equal(calls, 2);
    await advance(999);
    assert.equal(calls, 2);
    await advance(1);
    assert.equal(calls, 3);
    // No wake is delivered. The durable queue must still be observed within
    // one second; no hint or retained empty result authorizes skipping IO.
    needsDrain = true;
    await advance(999);
    assert.equal(drains, 0);
    await advance(1);
    assert.equal(calls, 4);
    assert.equal(drains, 1);
    await advance(249);
    assert.equal(calls, 4);
    await advance(1);
    assert.equal(calls, 5, 'Observed work restores the original fast interval.');

    needsDrain = true;
    worker.wake();
    await advance(0);
    assert.equal(calls, 6, 'A wake interrupts the idle timer immediately.');
    assert.equal(drains, 2);
    await advance(250);
    await advance(500);
    assert.equal(calls, 8);
    failNext = true;
    await advance(1000);
    assert.equal(calls, 9);
    assert.equal(errors, 1);
    await advance(249);
    assert.equal(calls, 9);
    await advance(1);
    assert.equal(calls, 10, 'Failed observations retry at the fast interval.');
    worker.dispose();
    await advance(10000);
    assert.equal(calls, 10, 'Dispose cancels a backed-off timer as well.');
  } finally {
    worker.dispose();
    mock.timers.reset();
  }
}

async function main() {
  await testSerialDedupAndWakeCoalescing();
  await testPeriodicRetryAndDispose();
  await testIdleBackoffRetainsBoundedDurableFallback();
  console.log('collaboration room admission worker tests passed (3 scenarios)');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
