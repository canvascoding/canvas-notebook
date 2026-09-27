import assert from 'node:assert/strict';
import * as Y from 'yjs';

import {
  CollaborationRoomOwnerError,
  type CollaborationRoomOwnerFence,
  type CollaborationRoomOwnerScope,
} from '../app/lib/collaboration/room-owner';
import { createCollaborationRoomOwnerRuntime } from '../app/lib/collaboration/room-owner-runtime';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function ownerScope(documentId: string): CollaborationRoomOwnerScope {
  return {
    documentId,
    workspaceId: 'runtime-test-workspace',
    organizationId: null,
    path: `${documentId}.md`,
    representation: 'plain_text',
    lifecycleGeneration: 1,
    schemaVersion: 1,
  };
}

function makeDoc(name: string): Y.Doc {
  const document = new Y.Doc({ guid: name });
  document.getText('content').insert(0, `${name}:`);
  return document;
}

function lostError(error: unknown): boolean {
  return error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_LOST';
}

type AcquireBlock = {
  documentId: string;
  entered: () => void;
  wait: Promise<void>;
  error?: Error;
};

type ReleaseBlock = {
  token: string;
  entered: () => void;
  wait: Promise<void>;
  error?: Error;
};

class FakeOwnerSession {
  readonly acquireCalls: CollaborationRoomOwnerScope[] = [];
  readonly releaseCalls: CollaborationRoomOwnerFence[] = [];
  readonly active = new Map<string, CollaborationRoomOwnerFence>();
  closeCalls = 0;
  probeCalls = 0;
  probeError: Error | null = null;
  blockAcquire: AcquireBlock | null = null;
  blockRelease: ReleaseBlock | null = null;
  acquireError: Error | null = null;
  onInvalidated: () => void;
  probeBlocks = new Map<number, { entered: () => void; wait: Promise<void> }>();

  constructor(onInvalidated: () => void) {
    this.onInvalidated = onInvalidated;
  }

  async acquire(scope: CollaborationRoomOwnerScope): Promise<CollaborationRoomOwnerFence> {
    this.acquireCalls.push(scope);
    const barrier = this.blockAcquire;
    if (barrier?.documentId === scope.documentId) {
      this.blockAcquire = null;
      barrier.entered();
      await barrier.wait;
      if (barrier.error) throw barrier.error;
    }
    if (this.acquireError) {
      const error = this.acquireError;
      this.acquireError = null;
      throw error;
    }
    const fence: CollaborationRoomOwnerFence = Object.freeze({
      scope: Object.freeze({ ...scope }),
      epoch: (this.active.get(scope.documentId)?.epoch ?? 0) + 1,
      token: `runtime-fence-${scope.documentId}-${this.acquireCalls.length}`,
      backendPid: 4567,
      backendStart: '1727370000.12345',
    });
    this.active.set(scope.documentId, fence);
    return fence;
  }

  async release(fence: CollaborationRoomOwnerFence): Promise<void> {
    this.releaseCalls.push(fence);
    const barrier = this.blockRelease;
    if (barrier?.token === fence.token) {
      this.blockRelease = null;
      barrier.entered();
      await barrier.wait;
      if (barrier.error) throw barrier.error;
    }
    if (this.active.get(fence.scope.documentId) === fence) this.active.delete(fence.scope.documentId);
  }

  assertActive(fence: CollaborationRoomOwnerFence): void {
    if (this.active.get(fence.scope.documentId) !== fence) {
      throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
    }
  }

  async probe(): Promise<void> {
    this.probeCalls += 1;
    if (this.probeError) throw this.probeError;
    const barrier = this.probeBlocks.get(this.probeCalls);
    if (barrier) barrier.entered();
    await barrier?.wait;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.active.clear();
    this.onInvalidated();
  }
}

function harness(heartbeatMs = 60) {
  let session: FakeOwnerSession | undefined;
  let createCalls = 0;
  const lostDocuments: Y.Doc[] = [];
  const runtime = createCollaborationRoomOwnerRuntime({
    heartbeatMs,
    createSession: async (onInvalidated) => {
      createCalls += 1;
      session = new FakeOwnerSession(onInvalidated);
      return session;
    },
    onLost: (document) => { lostDocuments.push(document); },
  });
  return {
    runtime,
    lostDocuments,
    get createCalls() { return createCalls; },
    get session() {
      if (!session) throw new Error('The fake owner session has not been created.');
      return session;
    },
  };
}

async function cleanup(runtime: ReturnType<typeof createCollaborationRoomOwnerRuntime>, documents: Y.Doc[]) {
  for (const document of documents) {
    await bounded(runtime.release(document), 'test cleanup room release', 500).catch(() => undefined);
  }
  await bounded(runtime.dispose(), 'test cleanup runtime disposal', 500).catch(() => undefined);
  for (const document of documents) if (!document.isDestroyed) document.destroy();
}

async function testConcurrentClaimsShareOneLazySessionAndRejectDuplicateRooms() {
  const factoryEntered = deferred();
  const allowFactory = deferred();
  let createCalls = 0;
  let session: FakeOwnerSession | undefined;
  const lostDocuments: Y.Doc[] = [];
  const runtime = createCollaborationRoomOwnerRuntime({
    heartbeatMs: 60,
    createSession: async (onInvalidated) => {
      createCalls += 1;
      factoryEntered.resolve();
      await allowFactory.promise;
      session = new FakeOwnerSession(onInvalidated);
      return session;
    },
    onLost: (document) => { lostDocuments.push(document); },
  });
  const first = makeDoc('lazy-first');
  const second = makeDoc('lazy-second');
  const duplicateId = makeDoc('lazy-first');
  let firstClaim: Promise<CollaborationRoomOwnerFence> | undefined;
  let secondClaim: Promise<CollaborationRoomOwnerFence> | undefined;
  try {
    const wideInput = {
      ...ownerScope('lazy-first'),
      path: 'original-lazy-first.md',
      yjsState: new Uint8Array(64 * 1024 * 1024),
      stateVector: new Uint8Array([1, 2, 3]),
      persistedAt: new Date(0),
    };
    firstClaim = runtime.claim(first, wideInput);
    wideInput.path = 'mutated-after-claim.md';
    secondClaim = runtime.claim(second, ownerScope('lazy-second'));
    void firstClaim.catch(() => undefined);
    void secondClaim.catch(() => undefined);
    await bounded(factoryEntered.promise, 'lazy owner session factory');
    assert.equal(createCalls, 1, 'concurrent claims share the same factory promise');
    allowFactory.resolve();
    const [firstFence] = await Promise.all([firstClaim, secondClaim]);
    assert.equal(createCalls, 1);
    assert.deepEqual(Object.keys(session!.acquireCalls[0]).sort(), [
      'documentId', 'lifecycleGeneration', 'organizationId', 'path', 'representation', 'schemaVersion', 'workspaceId',
    ], 'only the seven scalar ownership fields reach the owner session');
    assert.deepEqual(Object.keys(firstFence.scope).sort(), [
      'documentId', 'lifecycleGeneration', 'organizationId', 'path', 'representation', 'schemaVersion', 'workspaceId',
    ], 'the returned proof retains no unrelated persisted-state fields');
    assert.equal(firstFence.scope.path, 'original-lazy-first.md',
      'mutating a wider caller input after claim does not alter the snapshotted owner scope');
    assert.equal('yjsState' in firstFence.scope, false, 'large persisted snapshots are not retained in the proof');

    await assert.rejects(runtime.claim(first, ownerScope('lazy-first')), lostError,
      'one concrete Y.Doc cannot claim its released/already-claimed instance a second time');
    const acquiresBeforeDuplicate = session!.acquireCalls.length;
    await assert.rejects(runtime.claim(duplicateId, ownerScope('lazy-first')),
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY');
    assert.equal(session!.acquireCalls.length, acquiresBeforeDuplicate,
      'a second live Y.Doc with the same ID is rejected before another owner claim');
    assert.ok(runtime.fence(first));
  } finally {
    allowFactory.resolve();
    await Promise.all([firstClaim, secondClaim].filter((claim): claim is Promise<CollaborationRoomOwnerFence> => Boolean(claim))
      .map((claim) => bounded(claim, 'pending concurrent claim cleanup', 500).catch(() => undefined)));
    await cleanup(runtime, [first, second, duplicateId]);
  }
}

async function testDestroyDuringPendingClaimReleasesLateFence() {
  const document = makeDoc('destroy-during-claim');
  const entered = deferred();
  const allowAcquire = deferred();
  let session: FakeOwnerSession | undefined;
  const runtime = createCollaborationRoomOwnerRuntime({
    heartbeatMs: 60,
    createSession: async (onInvalidated) => {
      session = new FakeOwnerSession(onInvalidated);
      session.blockAcquire = { documentId: 'destroy-during-claim', entered: entered.resolve, wait: allowAcquire.promise };
      return session;
    },
    onLost: () => undefined,
  });
  let claim: Promise<CollaborationRoomOwnerFence> | undefined;
  try {
    claim = runtime.claim(document, ownerScope('destroy-during-claim'));
    void claim.catch(() => undefined);
    await bounded(entered.promise, 'blocked owner acquire');
    document.destroy();
    allowAcquire.resolve();
    await assert.rejects(claim, lostError);
    assert.equal(session!.releaseCalls.length, 1, 'a fence that arrives after destroy is explicitly released');
    assert.throws(() => runtime.fence(document), lostError);
  } finally {
    allowAcquire.resolve();
    if (claim) await bounded(claim, 'pending claim cleanup', 500).catch(() => undefined);
    await cleanup(runtime, [document]);
  }
}

async function testFailedClaimCleanupAndExplicitReleaseAfterLoadFailure() {
  const failedDocument = makeDoc('failed-claim-cleanup');
  const recoveredDocument = makeDoc('failed-claim-cleanup');
  let session: FakeOwnerSession | undefined;
  const runtime = createCollaborationRoomOwnerRuntime({
    heartbeatMs: 60,
    createSession: async (onInvalidated) => {
      session = new FakeOwnerSession(onInvalidated);
      session.acquireError = new CollaborationRoomOwnerError('ROOM_OWNER_SCOPE_CHANGED');
      return session;
    },
    onLost: () => undefined,
  });
  try {
    await assert.rejects(runtime.claim(failedDocument, ownerScope('failed-claim-cleanup')),
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_SCOPE_CHANGED');
    await runtime.release(failedDocument);
    assert.equal(session!.releaseCalls.length, 0, 'a failed owner acquisition has no fence to release');
    assert.equal(runtime.canUnload(failedDocument), true, 'failed claims do not quarantine the document');

    const fence = await runtime.claim(recoveredDocument, ownerScope('failed-claim-cleanup'));
    assert.ok(fence);
    await runtime.release(recoveredDocument);
    assert.equal(session!.releaseCalls.length, 1,
      'the caller explicitly releases ownership when its subsequent document load fails');
    assert.throws(() => runtime.fence(recoveredDocument), lostError);
  } finally {
    await cleanup(runtime, [failedDocument, recoveredDocument]);
  }
}

async function testNewInstanceWaitsForReleaseAcknowledgement() {
  const h = harness();
  const oldDocument = makeDoc('release-barrier');
  const nextDocument = makeDoc('release-barrier');
  const allowRelease = deferred();
  let release: Promise<void> | undefined;
  let nextClaim: Promise<CollaborationRoomOwnerFence> | undefined;
  try {
    const oldFence = await h.runtime.claim(oldDocument, ownerScope('release-barrier'));
    const entered = deferred();
    h.session.blockRelease = { token: oldFence.token, entered: entered.resolve, wait: allowRelease.promise };
    release = h.runtime.release(oldDocument);
    void release.catch(() => undefined);
    await bounded(entered.promise, 'release acknowledgement gate');

    nextClaim = h.runtime.claim(nextDocument, ownerScope('release-barrier'));
    void nextClaim.catch(() => undefined);
    await Promise.resolve();
    assert.equal(h.session.acquireCalls.length, 1,
      'a replacement Y.Doc waits while the prior instance release is unacknowledged');
    allowRelease.resolve();
    await bounded(release, 'old room release');
    const nextFence = await bounded(nextClaim, 'replacement room claim');
    assert.notEqual(nextFence.token, oldFence.token);
    h.runtime.fence(nextDocument);
    assert.throws(() => h.runtime.fence(oldDocument), lostError);
  } finally {
    allowRelease.resolve();
    for (const pending of [release, nextClaim]) {
      if (pending) await bounded<unknown>(pending, 'release barrier cleanup', 500).catch(() => undefined);
    }
    await cleanup(h.runtime, [oldDocument, nextDocument]);
  }
}

async function testReleaseFailureAndSessionLossFailClosedForEveryRoom() {
  const releaseHarness = harness();
  const first = makeDoc('release-failure-a');
  const second = makeDoc('release-failure-b');
  const allowFailure = deferred();
  let release: Promise<void> | undefined;
  try {
    await Promise.all([
      releaseHarness.runtime.claim(first, ownerScope('release-failure-a')),
      releaseHarness.runtime.claim(second, ownerScope('release-failure-b')),
    ]);
    const entered = deferred();
    releaseHarness.session.blockRelease = {
      token: releaseHarness.runtime.fence(first).token,
      entered: entered.resolve,
      wait: allowFailure.promise,
      error: new Error('injected explicit release failure'),
    };
    release = releaseHarness.runtime.release(first);
    void release.catch(() => undefined);
    await bounded(entered.promise, 'explicit release failure gate');
    assert.throws(() => releaseHarness.runtime.fence(first), lostError,
      'the local proof is invalid while the release acknowledgement is pending');
    allowFailure.resolve();
    await assert.rejects(release, /injected explicit release failure/u);
    assert.equal(releaseHarness.session.closeCalls, 1);
    for (const document of [first, second]) {
      assert.equal(releaseHarness.runtime.canUnload(document), false,
        'an uncertain release quarantines all live documents on the session');
      assert.throws(() => releaseHarness.runtime.fence(document), lostError);
    }
    await assert.rejects(releaseHarness.runtime.claim(makeDoc('release-failure-new'), ownerScope('new-after-failure')), lostError);
  } finally {
    allowFailure.resolve();
    if (release) await bounded(release, 'failed release cleanup', 500).catch(() => undefined);
    await cleanup(releaseHarness.runtime, [first, second]);
  }

  const lossHarness = harness();
  const liveRooms = [makeDoc('lost-room-a'), makeDoc('lost-room-b')];
  const newRoom = makeDoc('lost-room-new');
  try {
    await Promise.all(liveRooms.map((document) => lossHarness.runtime.claim(document, ownerScope(document.guid))));
    lossHarness.session.onInvalidated();
    assert.deepEqual(lossHarness.lostDocuments, liveRooms, 'session loss quarantines every live room once');
    for (const document of liveRooms) {
      assert.equal(lossHarness.runtime.canUnload(document), false);
      assert.throws(() => lossHarness.runtime.fence(document), lostError);
    }
    await assert.rejects(lossHarness.runtime.claim(newRoom, ownerScope('lost-room-new')), lostError,
      'session loss is terminal; a new room never receives unverified ownership');
    assert.equal(lossHarness.session.acquireCalls.length, 2);
  } finally {
    await cleanup(lossHarness.runtime, [...liveRooms, newRoom]);
  }
}

async function testLateFactoryResultIsClosedAfterDispose() {
  const factoryStarted = deferred();
  const finishFactory = deferred<FakeOwnerSession>();
  const lateSession = new FakeOwnerSession(() => undefined);
  let session: FakeOwnerSession | undefined;
  const lostDocuments: Y.Doc[] = [];
  const runtime = createCollaborationRoomOwnerRuntime({
    heartbeatMs: 60,
    createSession: async (onInvalidated) => {
      factoryStarted.resolve();
      session = await finishFactory.promise;
      session.onInvalidated = onInvalidated;
      return session;
    },
    onLost: (document) => { lostDocuments.push(document); },
  });
  const document = makeDoc('late-factory');
  let claim: Promise<CollaborationRoomOwnerFence> | undefined;
  try {
    claim = runtime.claim(document, ownerScope('late-factory'));
    void claim.catch(() => undefined);
    await bounded(factoryStarted.promise, 'delayed session factory');
    await runtime.dispose();
    finishFactory.resolve(lateSession);
    await assert.rejects(claim, (error) => error instanceof CollaborationRoomOwnerError
      && (error.code === 'ROOM_OWNER_UNAVAILABLE' || error.code === 'ROOM_OWNER_LOST'));
    await Promise.resolve();
    assert.equal(lateSession.closeCalls, 1, 'a factory result arriving after dispose is immediately closed');
    assert.deepEqual(lostDocuments, [document]);
    await assert.rejects(runtime.claim(makeDoc('late-factory-new'), ownerScope('late-factory-new')), lostError);
  } finally {
    finishFactory.resolve(lateSession);
    if (claim) await bounded(claim, 'late factory claim cleanup', 500).catch(() => undefined);
    await cleanup(runtime, [document]);
  }
}

async function testHeartbeatKeepsOnlyOneProbeInFlight() {
  let session: FakeOwnerSession | undefined;
  const firstEntered = deferred();
  const finishFirst = deferred();
  const secondEntered = deferred();
  const finishSecond = deferred();
  const document = makeDoc('heartbeat');
  const runtime = createCollaborationRoomOwnerRuntime({
    heartbeatMs: 10,
    createSession: async (onInvalidated) => {
      session = new FakeOwnerSession(onInvalidated);
      session.probeBlocks.set(1, { entered: firstEntered.resolve, wait: finishFirst.promise });
      session.probeBlocks.set(2, { entered: secondEntered.resolve, wait: finishSecond.promise });
      return session;
    },
    onLost: () => undefined,
  });
  try {
    await runtime.claim(document, ownerScope('heartbeat'));
    await bounded(firstEntered.promise, 'first heartbeat probe');
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(session!.probeCalls, 1, 'heartbeat ticks do not pile up behind a pending probe');

    finishFirst.resolve();
    await bounded(secondEntered.promise, 'next heartbeat after completion');
    assert.equal(session!.probeCalls, 2, 'heartbeat resumes after the in-flight probe finishes');
  } finally {
    finishFirst.resolve();
    finishSecond.resolve();
    await bounded(runtime.dispose(), 'heartbeat runtime disposal', 500).catch(() => undefined);
    if (!document.isDestroyed) document.destroy();
  }
}

async function testFailedHeartbeatProbeInvalidatesEveryRoom() {
  let session: FakeOwnerSession | undefined;
  const allRoomsLost = deferred();
  const lostDocuments: Y.Doc[] = [];
  const documents = [makeDoc('probe-loss-a'), makeDoc('probe-loss-b')];
  const rejectedDocument = makeDoc('probe-loss-new');
  const runtime = createCollaborationRoomOwnerRuntime({
    heartbeatMs: 10,
    createSession: async (onInvalidated) => {
      session = new FakeOwnerSession(onInvalidated);
      session.probeError = new Error('injected heartbeat failure');
      return session;
    },
    onLost: (document) => {
      lostDocuments.push(document);
      if (lostDocuments.length === documents.length) allRoomsLost.resolve();
    },
  });
  try {
    await Promise.all(documents.map((document) => runtime.claim(document, ownerScope(document.guid))));
    await bounded(allRoomsLost.promise, 'heartbeat session-loss notification');
    assert.equal(session!.probeCalls, 1, 'the first failed probe invalidates the session without overlapping probes');
    assert.equal(session!.closeCalls, 1);
    assert.deepEqual(lostDocuments, documents, 'one failed probe quarantines every document sharing the session');
    for (const document of documents) {
      assert.equal(runtime.canUnload(document), false);
      assert.throws(() => runtime.fence(document), lostError);
    }
    await assert.rejects(runtime.claim(rejectedDocument, ownerScope(rejectedDocument.guid)), lostError,
      'a fresh claim cannot silently replace a session whose heartbeat failed');
  } finally {
    await bounded(runtime.dispose(), 'failed heartbeat runtime disposal', 500).catch(() => undefined);
    for (const document of [...documents, rejectedDocument]) {
      if (!document.isDestroyed) document.destroy();
    }
  }
}

async function main() {
  await testConcurrentClaimsShareOneLazySessionAndRejectDuplicateRooms();
  await testDestroyDuringPendingClaimReleasesLateFence();
  await testFailedClaimCleanupAndExplicitReleaseAfterLoadFailure();
  await testNewInstanceWaitsForReleaseAcknowledgement();
  await testReleaseFailureAndSessionLossFailClosedForEveryRoom();
  await testLateFactoryResultIsClosedAfterDispose();
  await testHeartbeatKeepsOnlyOneProbeInFlight();
  await testFailedHeartbeatProbeInvalidatesEveryRoom();
  console.log('collaboration room-owner runtime tests passed (8 scenarios)');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
