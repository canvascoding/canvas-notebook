import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CollaborationRoomActivityError,
  createCollaborationRoomActivityGate,
} from '../app/lib/collaboration/room-activity-gate';

function assertActivityError(action: () => unknown, code: CollaborationRoomActivityError['code']) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof CollaborationRoomActivityError);
    assert.equal(error.code, code);
    return true;
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('admission enforces per-document, global, and document-map bounds and releases idempotently', () => {
  const gate = createCollaborationRoomActivityGate({
    maxDocuments: 2,
    maxActivitiesPerDocument: 1,
    maxActivities: 2,
  });
  const first = gate.admit('room-a');
  const second = gate.admit('room-b');
  assertActivityError(() => gate.admit('room-a'), 'ROOM_ACTIVITY_BUSY');
  assertActivityError(() => gate.admit('room-c'), 'ROOM_ACTIVITY_BUSY');

  first.release();
  first.release();
  const third = gate.admit('room-c');
  assertActivityError(() => gate.admit('room-d'), 'ROOM_ACTIVITY_BUSY');
  second.release();
  third.release();
  const afterCleanup = gate.admit('room-d');
  afterCleanup.release();
});

test('leases do not expire without release, even after a short wait', async () => {
  const gate = createCollaborationRoomActivityGate({ maxActivities: 1 });
  const lease = gate.admit('room');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assertActivityError(() => gate.admit('room'), 'ROOM_ACTIVITY_BUSY');
  lease.release();
  const next = gate.admit('room');
  next.release();
});

test('drain closes admission synchronously and idle resolves only after every real lease releases', async () => {
  const gate = createCollaborationRoomActivityGate();
  const direct = gate.admit('room');
  const peer = gate.admit('room');
  const drain = gate.beginDrain('room');
  let idle = false;
  void drain.idle.then(() => { idle = true; });

  assertActivityError(() => gate.admit('room'), 'ROOM_ACTIVITY_DRAINING');
  assertActivityError(() => direct.assertOpen(), 'ROOM_ACTIVITY_DRAINING');
  await Promise.resolve();
  assert.equal(idle, false);
  assertActivityError(() => drain.finish(), 'ROOM_ACTIVITY_BUSY');

  // A direct operation already admitted before drain may complete without a peer-style recheck.
  direct.release();
  await Promise.resolve();
  assert.equal(idle, false, 'one remaining lease prevents the drain from becoming idle');
  assertActivityError(() => peer.assertOpen(), 'ROOM_ACTIVITY_DRAINING');
  peer.release();
  await drain.idle;
  assert.equal(idle, true);
  drain.finish();
  drain.finish();

  const next = gate.admit('room');
  next.release();
});

test('drain handles are exclusive, and a finished stale handle cannot finish a newer drain', async () => {
  const gate = createCollaborationRoomActivityGate();
  const firstDrain = gate.beginDrain('room');
  await firstDrain.idle;
  assertActivityError(() => gate.beginDrain('room'), 'ROOM_ACTIVITY_DRAINING');
  firstDrain.finish();

  const lease = gate.admit('room');
  const secondDrain = gate.beginDrain('room');
  firstDrain.finish();
  assertActivityError(() => gate.admit('room'), 'ROOM_ACTIVITY_DRAINING');
  lease.release();
  await secondDrain.idle;
  secondDrain.finish();
});

test('drain state is independent across documents', async () => {
  const gate = createCollaborationRoomActivityGate();
  const roomALease = gate.admit('room-a');
  const drainA = gate.beginDrain('room-a');
  const roomBLease = gate.admit('room-b');
  roomBLease.assertOpen();
  roomBLease.release();
  assertActivityError(() => gate.admit('room-a'), 'ROOM_ACTIVITY_DRAINING');
  const anotherB = gate.admit('room-b');
  anotherB.release();
  roomALease.release();
  await drainA.idle;
  drainA.finish();
});

test('failed work does not implicitly release its lease or erase an active drain', async () => {
  const gate = createCollaborationRoomActivityGate();
  const lease = gate.admit('room');
  const failure = new Error('operation failed');
  await assert.rejects(Promise.reject(failure), (error: unknown) => error === failure);
  const drain = gate.beginDrain('room');
  const idle = deferred();
  void drain.idle.then(idle.resolve);
  let becameIdle = false;
  void idle.promise.then(() => { becameIdle = true; });
  await Promise.resolve();
  assert.equal(becameIdle, false, 'the failed operation still owns its lease until explicitly released');
  assertActivityError(() => drain.finish(), 'ROOM_ACTIVITY_BUSY');

  lease.release();
  await drain.idle;
  drain.finish();
});

test('dispose rejects new work but preserves active counts until actual release', async () => {
  const gate = createCollaborationRoomActivityGate();
  const lease = gate.admit('room');
  const drain = gate.beginDrain('room');
  gate.dispose();
  gate.dispose();

  assertActivityError(() => gate.admit('other-room'), 'ROOM_ACTIVITY_CLOSED');
  assertActivityError(() => gate.beginDrain('other-room'), 'ROOM_ACTIVITY_CLOSED');
  assertActivityError(() => lease.assertOpen(), 'ROOM_ACTIVITY_CLOSED');
  assertActivityError(() => drain.finish(), 'ROOM_ACTIVITY_BUSY');
  let idle = false;
  void drain.idle.then(() => { idle = true; });
  await Promise.resolve();
  assert.equal(idle, false, 'disposal cannot fake idle while a lease remains active');

  lease.release();
  await drain.idle;
  drain.finish();
});

test('empty document IDs and invalid capacity options are rejected', () => {
  const gate = createCollaborationRoomActivityGate();
  assert.throws(() => gate.admit(''), TypeError);
  assert.throws(() => gate.beginDrain(''), TypeError);
  assert.throws(() => createCollaborationRoomActivityGate({ maxActivities: 0 }), RangeError);
});

test('isIdle is synchronous and false while active, draining, or disposed', () => {
  const gate = createCollaborationRoomActivityGate();
  assert.equal(gate.isIdle('missing-room'), true);
  const lease = gate.admit('room');
  assert.equal(gate.isIdle('room'), false);
  lease.release();
  assert.equal(gate.isIdle('room'), true);

  const drain = gate.beginDrain('room');
  assert.equal(gate.isIdle('room'), false, 'a drain record is not idle for a new terminal attempt');
  drain.finish();
  assert.equal(gate.isIdle('room'), true);

  gate.dispose();
  assert.equal(gate.isIdle('missing-room'), false, 'disposed gate never advertises idle as admission-ready');
});
