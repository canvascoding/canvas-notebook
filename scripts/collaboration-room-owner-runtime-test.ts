import assert from 'node:assert/strict';
import * as Y from 'yjs';

import {
  CollaborationRoomOwnerError,
  type CollaborationRoomOwnerFence,
  type CollaborationRoomOwnerScope,
} from '../app/lib/collaboration/room-owner';
import type {
  CollaborationRoomReleaseReceipt,
  CollaborationRoomReleaseSnapshot,
} from '../app/lib/collaboration/room-owner-release';
import { admissionDrainTicketForTarget } from '../app/lib/collaboration/room-admission-drain';
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

function releaseSnapshot(document: Y.Doc, releaseId: string): CollaborationRoomReleaseSnapshot {
  return {
    releaseId,
    yjsState: Y.encodeStateAsUpdate(document),
    stateVector: Y.encodeStateVector(document),
  };
}

function drainTicket(fence: CollaborationRoomOwnerFence, requestId = '77777777-7777-4777-8777-777777777777') {
  return admissionDrainTicketForTarget(requestId, 'a'.repeat(64), {
    document: { ...fence.scope, status: 'active' },
    ownerEpoch: fence.epoch,
    ownerToken: fence.token,
    ownerBackendPid: fence.backendPid,
    ownerBackendStart: fence.backendStart,
    documentSequence: 0,
  });
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
  readonly releaseSnapshots: Array<CollaborationRoomReleaseSnapshot | undefined> = [];
  readonly active = new Map<string, CollaborationRoomOwnerFence>();
  closeCalls = 0;
  closeError: Error | null = null;
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

  async release(fence: CollaborationRoomOwnerFence, snapshot?: CollaborationRoomReleaseSnapshot): Promise<void> {
    this.releaseCalls.push(fence);
    this.releaseSnapshots.push(snapshot);
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
    if (this.closeError) throw this.closeError;
  }
}

function harness(heartbeatMs = 60, recoverRelease?: (input: {
  fence: CollaborationRoomOwnerFence;
  snapshot: CollaborationRoomReleaseSnapshot;
}) => Promise<CollaborationRoomReleaseReceipt>, onActivityIdle?: (documentId: string) => void) {
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
    recoverRelease,
    onActivityIdle,
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
    assert.equal(session!.releaseSnapshots[0], undefined,
      'ordinary cleanup release never fabricates a durable snapshot receipt');
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

async function testTerminalDrainCopiesSnapshotAndReopensOnlyAfterDurableDestroy() {
  const h = harness();
  const document = makeDoc('terminal-durable');
  const sameIdCandidate = makeDoc('terminal-durable');
  const replacement = makeDoc('terminal-durable');
  const releaseEntered = deferred();
  const allowRelease = deferred();
  try {
    const fence = await h.runtime.claim(document, ownerScope('terminal-durable'));
    const activity = h.runtime.admitActivity('terminal-durable');
    const drain = h.runtime.beginTerminalDrain(document);
    assert.equal(h.runtime.isDraining('terminal-durable'), true);
    assert.equal(h.runtime.canUnload(document), false);
    assert.equal(h.runtime.fence(document), fence,
      'terminal quiescence retains the owner fence for the final store');
    assert.throws(() => h.runtime.beginTerminalDrain(document),
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY');
    assert.throws(() => h.runtime.beginTerminalDrain(sameIdCandidate), lostError,
      'a terminal handle is bound to the exact claimed Y.Doc');
    await assert.rejects(h.runtime.claim(sameIdCandidate, ownerScope('terminal-durable')),
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY',
      'the draining document ID cannot be claimed by another instance');
    await assert.rejects(drain.releaseDurably(releaseSnapshot(
      document, '11111111-1111-4111-8111-111111111111',
    )), (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY',
    'durable release is rejected until every admitted activity is idle');
    assert.equal(h.session.releaseCalls.length, 0);

    activity.release();
    await bounded(drain.idle, 'terminal activity quiescence');
    assert.equal(h.runtime.fence(document), fence,
      'the final store can still use the exact fence after activity quiescence');
    assert.throws(() => drain.finish(),
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY');
    assert.throws(() => drain.releaseDurably({
      releaseId: '55555555-5555-4555-8555-555555555555',
      yjsState: new Uint8Array(),
      stateVector: Uint8Array.of(1),
    }), /verified durable release/u,
    'invalid release bytes are rejected synchronously before revoking the fence');
    assert.equal(h.runtime.fence(document), fence);

    const input = releaseSnapshot(document, '22222222-2222-4222-8222-222222222222');
    const expectedUpdate = new Uint8Array(input.yjsState);
    const expectedVector = new Uint8Array(input.stateVector);
    h.session.blockRelease = {
      token: fence.token,
      entered: releaseEntered.resolve,
      wait: allowRelease.promise,
    };
    const release = drain.releaseDurably(input);
    input.yjsState.fill(0);
    input.stateVector.fill(0);
    await bounded(releaseEntered.promise, 'terminal owner release acknowledgement');
    assert.throws(() => h.runtime.fence(document), lostError,
      'calling releaseDurably revokes the runtime fence before awaiting SQL');
    assert.equal(h.runtime.canUnload(document), false,
      'an unacknowledged durable release is not unloadable');
    assert.deepEqual(h.session.releaseSnapshots[0]?.yjsState, expectedUpdate,
      'releaseDurably copies update bytes synchronously');
    assert.deepEqual(h.session.releaseSnapshots[0]?.stateVector, expectedVector,
      'releaseDurably copies vector bytes synchronously');
    const waitingClaim = h.runtime.claim(sameIdCandidate, ownerScope('terminal-durable'));
    void waitingClaim.catch(() => undefined);
    await Promise.resolve();
    assert.equal(h.session.acquireCalls.length, 1,
      'a new claim waits for the terminal release acknowledgement');
    allowRelease.resolve();
    await bounded(release, 'terminal durable owner release');
    assert.deepEqual(h.lostDocuments, [], 'an acknowledged terminal release does not invalidate the owner session');
    await assert.rejects(waitingClaim,
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY',
      'an acknowledged release still cannot reopen the ID before finish');
    assert.equal(h.runtime.canUnload(document), true,
      'only the exact durably released Y.Doc becomes unloadable');
    assert.equal(h.runtime.canUnload(sameIdCandidate), true,
      'an unrelated unclaimed Y.Doc has no runtime quarantine state');
    assert.throws(() => drain.finish(),
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY',
      'finish cannot reopen the ID before the released Y.Doc is destroyed');
    await assert.rejects(h.runtime.claim(sameIdCandidate, ownerScope('terminal-durable')),
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY');

    document.destroy();
    await Promise.resolve();
    assert.equal(h.session.releaseCalls.length, 1,
      'destroy after durable proof does not trigger a second legacy release');
    drain.finish();
    assert.equal(h.runtime.isDraining('terminal-durable'), false);
    const replacementFence = await h.runtime.claim(replacement, ownerScope('terminal-durable'));
    drain.finish();
    await assert.rejects(drain.releaseDurably(input),
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_SCOPE_CHANGED',
      'mutated caller buffers cannot be reused as the original durable release proof');
    await drain.releaseDurably({
      releaseId: input.releaseId,
      yjsState: expectedUpdate,
      stateVector: expectedVector,
    });
    assert.equal(h.runtime.fence(replacement), replacementFence,
      'a completed stale drain handle cannot affect the replacement room');
    assert.equal(h.session.releaseCalls.length, 1,
      'reusing a completed drain handle does not issue another owner release');
  } finally {
    allowRelease.resolve();
    await cleanup(h.runtime, [document, sameIdCandidate, replacement]);
  }
}

async function testIdleTerminalDrainDefersBusyRoomsAndActivityIdleNotifiesOnce() {
  const activityIdle: string[] = [];
  const h = harness(60, undefined, (documentId) => { activityIdle.push(documentId); });
  const document = makeDoc('idle-terminal');
  try {
    const fence = await h.runtime.claim(document, ownerScope('idle-terminal'));
    const first = h.runtime.admitActivity('idle-terminal');
    const second = h.runtime.admitActivity('idle-terminal');
    const releaseCount = h.session.releaseCalls.length;

    assert.equal(h.runtime.tryBeginIdleTerminalDrain(document), undefined,
      'an active admitted operation defers an idle-only terminal drain synchronously');
    assert.equal(h.runtime.isDraining('idle-terminal'), false);
    assert.equal(h.runtime.fence(document), fence);
    assert.equal(h.runtime.canUnload(document), true);
    assert.equal(h.session.releaseCalls.length, releaseCount, 'the deferred attempt has no owner-session side effects');

    first.release();
    first.release();
    assert.deepEqual(activityIdle, [], 'the callback waits until the last real lease releases');
    second.release();
    second.release();
    assert.deepEqual(activityIdle, ['idle-terminal'], 'the last lease produces one callback despite repeated release');

    const drain = h.runtime.tryBeginIdleTerminalDrain(document);
    assert.ok(drain, 'once idle, terminal drain begins without an asynchronous gap');
    assert.equal(h.runtime.tryBeginIdleTerminalDrain(document), undefined,
      'an existing terminal drain is not adopted as a second idle drain');
    await bounded(drain.idle, 'idle terminal drain');
    assert.equal(h.session.releaseCalls.length, releaseCount);
    await drain.releaseDurably(releaseSnapshot(document, '75757575-7575-4757-8757-757575757575'));
    document.destroy();
    drain.finish();
    assert.deepEqual(activityIdle, ['idle-terminal'], 'draining suppresses later idle notifications');
  } finally {
    await cleanup(h.runtime, [document]);
  }

  const drainingNotifications: string[] = [];
  const drainingHarness = harness(60, undefined, (documentId) => { drainingNotifications.push(documentId); });
  const drainingDocument = makeDoc('activity-drain-callback');
  try {
    await drainingHarness.runtime.claim(drainingDocument, ownerScope('activity-drain-callback'));
    const active = drainingHarness.runtime.admitActivity('activity-drain-callback');
    const drain = drainingHarness.runtime.beginTerminalDrain(drainingDocument);
    active.release();
    await bounded(drain.idle, 'activity drain callback suppression');
    assert.deepEqual(drainingNotifications, [], 'release during an explicit drain does not schedule idle work');
    await drain.releaseDurably(releaseSnapshot(drainingDocument, '76767676-7676-4767-8767-767676767676'));
    drainingDocument.destroy();
    drain.finish();
  } finally {
    await cleanup(drainingHarness.runtime, [drainingDocument]);
  }

  const disposedNotifications: string[] = [];
  const disposedHarness = harness(60, undefined, (documentId) => { disposedNotifications.push(documentId); });
  const disposedDocument = makeDoc('activity-disposed-callback');
  try {
    await disposedHarness.runtime.claim(disposedDocument, ownerScope('activity-disposed-callback'));
    const active = disposedHarness.runtime.admitActivity('activity-disposed-callback');
    await disposedHarness.runtime.dispose();
    active.release();
    active.release();
    assert.deepEqual(disposedNotifications, [], 'disposed runtime suppresses idle callbacks');
  } finally {
    await cleanup(disposedHarness.runtime, [disposedDocument]);
  }
}

async function testTerminalReleaseRecoveryRetriesOnlyProofAndDeduplicatesConcurrentCalls() {
  const recoveryEntered = deferred();
  const allowFirstRecovery = deferred();
  const recoveryCalls: Array<{ fence: CollaborationRoomOwnerFence; snapshot: CollaborationRoomReleaseSnapshot }> = [];
  let ownerSessionCloseCalls = () => 0;
  const h = harness(60, async (input) => {
    assert.equal(ownerSessionCloseCalls(), 1, 'receipt inspection starts after the lost owner session is closed');
    recoveryCalls.push(input);
    if (recoveryCalls.length === 1) {
      recoveryEntered.resolve();
      await allowFirstRecovery.promise;
      throw new Error('temporary receipt read failure');
    }
    return { release_id: input.snapshot.releaseId } as CollaborationRoomReleaseReceipt;
  });
  ownerSessionCloseCalls = () => h.session.closeCalls;
  const document = makeDoc('terminal-recovery-retry');
  const sibling = makeDoc('terminal-recovery-retry-sibling');
  const wrongBytesDoc = makeDoc('different-release-bytes');
  try {
    const [fence] = await Promise.all([
      h.runtime.claim(document, ownerScope('terminal-recovery-retry')),
      h.runtime.claim(sibling, ownerScope('terminal-recovery-retry-sibling')),
    ]);
    const ticket = drainTicket(fence, '79797979-7979-4979-8979-797979797979');
    const drain = h.runtime.beginTerminalDrain(document, ticket);
    await bounded(drain.idle, 'retry terminal activity drain');
    h.session.blockRelease = {
      token: fence.token,
      entered: () => undefined,
      wait: Promise.resolve(),
      error: new Error('uncertain terminal release acknowledgement'),
    };
    const snapshot = {
      ...releaseSnapshot(document, ticket.releaseId),
      admission: ticket,
    };
    const firstAttempt = drain.releaseDurably(snapshot);
    void firstAttempt.catch(() => undefined);
    await bounded(recoveryEntered.promise, 'first release receipt recovery');

    const sameSnapshot = {
      ...snapshot,
      yjsState: new Uint8Array(snapshot.yjsState),
      stateVector: new Uint8Array(snapshot.stateVector),
    };
    const concurrentAttempt = drain.releaseDurably(sameSnapshot);
    assert.equal(concurrentAttempt, firstAttempt, 'concurrent exact retries share one in-flight recovery promise');
    const wrongId = { ...sameSnapshot, releaseId: '80808080-8080-4880-8880-808080808080' };
    await assert.rejects(drain.releaseDurably(wrongId),
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_SCOPE_CHANGED');
    const wrongBytes = { ...releaseSnapshot(wrongBytesDoc, snapshot.releaseId), admission: ticket };
    await assert.rejects(drain.releaseDurably(wrongBytes),
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_SCOPE_CHANGED');
    assert.equal(recoveryCalls.length, 1, 'wrong inputs cannot reach receipt recovery');

    allowFirstRecovery.resolve();
    await assert.rejects(firstAttempt, /temporary receipt read failure/u);
    assert.equal(h.session.releaseCalls.length, 1);
    assert.deepEqual(h.lostDocuments, [document, sibling], 'the shared session loss quarantines sibling rooms');
    assert.equal(h.runtime.canUnload(document), false, 'a failed read-only recovery is not release proof');
    assert.equal(h.runtime.canUnload(sibling), false);
    await Promise.resolve();

    const retry = drain.releaseDurably(sameSnapshot);
    await bounded(retry, 'second release receipt recovery');
    assert.equal(recoveryCalls.length, 2);
    assert.equal(h.session.releaseCalls.length, 1,
      'retry after positive session close does not execute release SQL again');
    assert.equal(h.session.closeCalls, 1);
    assert.equal(h.runtime.canUnload(document), true, 'only the positive receipt makes the target unloadable');
    assert.equal(h.runtime.canUnload(sibling), false, 'receipt proof does not unquarantine a sibling');
    assert.throws(() => h.runtime.fence(sibling), lostError);

    document.destroy();
    drain.finish();
  } finally {
    allowFirstRecovery.resolve();
    await cleanup(h.runtime, [document, sibling, wrongBytesDoc]);
  }
}

async function testTerminalDrainRecoversOnlyAfterClosingLostSession() {
  let ownerSessionCloseCalls = () => 0;
  const recoveryCalls: Array<{
    fence: CollaborationRoomOwnerFence;
    snapshot: CollaborationRoomReleaseSnapshot;
  }> = [];
  const h = harness(60, async (input) => {
    assert.equal(ownerSessionCloseCalls(), 1,
      'receipt recovery starts only after the uncertain owner session is closed');
    recoveryCalls.push(input);
    return { release_id: input.snapshot.releaseId } as CollaborationRoomReleaseReceipt;
  });
  ownerSessionCloseCalls = () => h.session.closeCalls;
  const document = makeDoc('terminal-recovered');
  const sibling = makeDoc('terminal-recovery-sibling');
  try {
    const [fence] = await Promise.all([
      h.runtime.claim(document, ownerScope('terminal-recovered')),
      h.runtime.claim(sibling, ownerScope('terminal-recovery-sibling')),
    ]);
    const drain = h.runtime.beginTerminalDrain(document);
    await drain.idle;
    h.session.blockRelease = {
      token: fence.token,
      entered: () => undefined,
      wait: Promise.resolve(),
      error: new Error('lost terminal release acknowledgement'),
    };
    const input = releaseSnapshot(document, '33333333-3333-4333-8333-333333333333');
    await drain.releaseDurably(input);
    assert.equal(h.session.closeCalls, 1);
    assert.deepEqual(h.lostDocuments, [document, sibling],
      'session close quarantines every room before recovery proves one release');
    assert.equal(recoveryCalls.length, 1);
    assert.equal(recoveryCalls[0].fence, fence);
    assert.notEqual(recoveryCalls[0].snapshot, input);
    assert.equal(h.runtime.canUnload(document), true,
      'positive receipt recovery makes only the old terminal Y.Doc unloadable');
    assert.equal(h.runtime.canUnload(sibling), false,
      'other rooms on the lost session remain quarantined');
    assert.throws(() => h.runtime.fence(sibling), lostError);
    document.destroy();
    drain.finish();
    assert.equal(h.session.releaseCalls.length, 1);
  } finally {
    await cleanup(h.runtime, [document, sibling]);
  }
}

async function testTerminalDrainRejectsUnprovenRecoveryAndLegacyAbandon() {
  let recoverySawClosedSession = false;
  let ownerSessionCloseCalls = () => 0;
  const h = harness(60, async () => {
    recoverySawClosedSession = ownerSessionCloseCalls() === 1;
    throw new Error('release receipt not found');
  });
  ownerSessionCloseCalls = () => h.session.closeCalls;
  const document = makeDoc('terminal-unproven');
  const sibling = makeDoc('terminal-unproven-sibling');
  try {
    const [fence] = await Promise.all([
      h.runtime.claim(document, ownerScope('terminal-unproven')),
      h.runtime.claim(sibling, ownerScope('terminal-unproven-sibling')),
    ]);
    const drain = h.runtime.beginTerminalDrain(document);
    await drain.idle;
    await assert.rejects(h.runtime.release(document),
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY',
      'legacy snapshot-less release cannot abandon an unfinished terminal drain');
    assert.equal(h.session.releaseCalls.length, 0);
    h.session.blockRelease = {
      token: fence.token,
      entered: () => undefined,
      wait: Promise.resolve(),
      error: new Error('uncertain release'),
    };
    await assert.rejects(drain.releaseDurably(releaseSnapshot(
      document, '44444444-4444-4444-8444-444444444444',
    )), /release receipt not found/u);
    assert.equal(recoverySawClosedSession, true);
    assert.equal(h.runtime.canUnload(document), false,
      'failed receipt recovery retains the terminal room quarantine');
    assert.equal(h.runtime.canUnload(sibling), false);
    document.destroy();
    await Promise.resolve();
    assert.equal(h.session.releaseCalls.length, 1,
      'destroy cannot fall back to a second snapshot-less release');
    assert.throws(() => drain.finish(),
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY');
  } finally {
    await cleanup(h.runtime, [document, sibling]);
  }
}

async function testTerminalDrainDoesNotRecoverUntilSessionCloseIsProven() {
  let recoveryCalls = 0;
  const h = harness(60, async (input) => {
    recoveryCalls += 1;
    return { release_id: input.snapshot.releaseId } as CollaborationRoomReleaseReceipt;
  });
  const document = makeDoc('terminal-close-failure');
  try {
    const fence = await h.runtime.claim(document, ownerScope('terminal-close-failure'));
    const drain = h.runtime.beginTerminalDrain(document);
    await drain.idle;
    const releaseError = new Error('uncertain terminal release');
    const closeError = new Error('owner backend close failed');
    h.session.blockRelease = {
      token: fence.token,
      entered: () => undefined,
      wait: Promise.resolve(),
      error: releaseError,
    };
    h.session.closeError = closeError;
    const snapshot = releaseSnapshot(document, '66666666-6666-4666-8666-666666666666');
    await assert.rejects(drain.releaseDurably(snapshot), (error) => error instanceof AggregateError
      && error.errors[0] === releaseError && error.errors[1] === closeError);
    assert.equal(h.session.closeCalls, 1);
    assert.equal(recoveryCalls, 0,
      'receipt recovery never overlaps an owner backend whose close failed');
    await assert.rejects(drain.releaseDurably({
      ...snapshot,
      yjsState: new Uint8Array(snapshot.yjsState),
      stateVector: new Uint8Array(snapshot.stateVector),
    }), (error) => error instanceof AggregateError
      && error.errors[0] === releaseError && error.errors[1] === closeError,
    'a failed backend-close proof cannot retry recovery or rerun release');
    assert.equal(h.session.releaseCalls.length, 1);
    assert.equal(h.session.closeCalls, 1);
    assert.equal(recoveryCalls, 0);
    assert.equal(h.runtime.canUnload(document), false,
      'failed backend-close proof leaves the exact terminal room quarantined');
    assert.equal(h.runtime.isDraining('terminal-close-failure'), true,
      'a failed terminal release never reopens room activity admission');
    assert.throws(() => drain.finish(),
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY');
  } finally {
    await cleanup(h.runtime, [document]);
  }
}

async function testAdmissionTicketBindsReentrantTerminalDrainAndRetainsReleasedProof() {
  const h = harness();
  const document = makeDoc('ticket-bound-terminal');
  try {
    const fence = await h.runtime.claim(document, ownerScope(document.guid));
    const ticket = drainTicket(fence);
    const other = drainTicket(fence, '88888888-8888-4888-8888-888888888888');
    const drain = h.runtime.beginTerminalDrain(document, ticket);
    assert.equal(h.runtime.beginTerminalDrain(document, ticket), drain,
      'the exact repeated ticket resumes one local terminal drain');
    assert.throws(() => h.runtime.beginTerminalDrain(document, other),
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY',
      'a different request cannot adopt an existing terminal drain');
    await drain.idle;
    await assert.rejects(drain.releaseDurably(releaseSnapshot(document, ticket.releaseId)),
      (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_SCOPE_CHANGED',
      'a bound drain rejects a release snapshot that omits its admission ticket');
    await assert.rejects(drain.releaseDurably({
      ...releaseSnapshot(document, other.releaseId), admission: other,
    }), (error) => error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_SCOPE_CHANGED',
    'a bound drain rejects another request before revoking its owner fence');
    assert.equal(h.runtime.fence(document), fence);
    await drain.releaseDurably({ ...releaseSnapshot(document, ticket.releaseId), admission: ticket });
    document.destroy();
    assert.deepEqual(h.runtime.listOwnedFences(), [fence],
      'a released but unfinished exact proof survives destroy for dispatcher retry');
    const resumed = h.runtime.resumeTerminalDrain(ticket);
    assert.equal(resumed?.document, document);
    assert.equal(resumed?.drain, drain);
    drain.finish();
    assert.deepEqual(h.runtime.listOwnedFences(), []);
    assert.equal(h.runtime.resumeTerminalDrain(ticket), undefined);
  } finally {
    await cleanup(h.runtime, [document]);
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
  await testTerminalDrainCopiesSnapshotAndReopensOnlyAfterDurableDestroy();
  await testIdleTerminalDrainDefersBusyRoomsAndActivityIdleNotifiesOnce();
  await testTerminalReleaseRecoveryRetriesOnlyProofAndDeduplicatesConcurrentCalls();
  await testTerminalDrainRecoversOnlyAfterClosingLostSession();
  await testTerminalDrainRejectsUnprovenRecoveryAndLegacyAbandon();
  await testTerminalDrainDoesNotRecoverUntilSessionCloseIsProven();
  await testAdmissionTicketBindsReentrantTerminalDrainAndRetainsReleasedProof();
  await testLateFactoryResultIsClosedAfterDispose();
  await testHeartbeatKeepsOnlyOneProbeInFlight();
  await testFailedHeartbeatProbeInvalidatesEveryRoom();
  console.log('collaboration room-owner runtime tests passed (15 scenarios)');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
