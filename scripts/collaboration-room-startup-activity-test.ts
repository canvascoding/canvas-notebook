import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CollaborationRoomActivityError, createCollaborationRoomActivityGate } from '../app/lib/collaboration/room-activity-gate';
import { createCollaborationRoomStartupActivity } from '../app/lib/collaboration/room-startup-activity';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function assertActivityError(promise: Promise<unknown>, code: CollaborationRoomActivityError['code']) {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof CollaborationRoomActivityError);
    assert.equal(error.code, code);
    return true;
  });
}

test('cancel during pending authentication retains admission until phase settlement and explicit finish', async () => {
  const gate = createCollaborationRoomActivityGate({ maxActivitiesPerDocument: 1 });
  const lease = gate.admit('startup-room');
  let finished = 0;
  const startup = createCollaborationRoomStartupActivity({ activity: lease, onFinished: () => { finished += 1; } });
  const entered = deferred();
  const completeAuthentication = deferred<string>();
  const authentication = startup.run(async () => {
    entered.resolve();
    return completeAuthentication.promise;
  });
  await entered.promise;

  startup.cancel();
  await assertActivityError(Promise.resolve().then(() => gate.admit('startup-room')), 'ROOM_ACTIVITY_BUSY');
  assert.equal(finished, 0, 'cancel cannot release an in-flight authentication phase');
  completeAuthentication.resolve('authenticated');
  await assertActivityError(authentication, 'ROOM_ACTIVITY_CLOSED');
  await assertActivityError(Promise.resolve().then(() => gate.admit('startup-room')), 'ROOM_ACTIVITY_BUSY');
  assert.equal(finished, 0, 'settling an abandoned phase is not the caller cleanup boundary');
  startup.finish();
  assert.equal(finished, 1);

  const next = gate.admit('startup-room');
  next.release();
});

test('load failure cancels but remains admitted until caller cleanup finishes', async () => {
  const gate = createCollaborationRoomActivityGate({ maxActivitiesPerDocument: 1 });
  const lease = gate.admit('load-failure');
  let finished = 0;
  const startup = createCollaborationRoomStartupActivity({ activity: lease, onFinished: () => { finished += 1; } });
  const failure = new Error('load failed');

  await assert.rejects(startup.run(async () => { throw failure; }), (error: unknown) => error === failure);
  assert.equal(finished, 0, 'a failed phase does not prove its caller finished cleanup');
  await assertActivityError(Promise.resolve().then(() => gate.admit('load-failure')), 'ROOM_ACTIVITY_BUSY');
  startup.cancel();
  assert.equal(finished, 0);
  startup.finish();
  assert.equal(finished, 1);
  startup.cancel();
  startup.finish();
  assert.equal(finished, 1, 'terminal calls and release notification are idempotent');
  await assertActivityError(startup.run(async () => 'should not run'), 'ROOM_ACTIVITY_CLOSED');

  const next = gate.admit('load-failure');
  next.release();
});

test('successful authentication phase retains admission across the gap and cancellation blocks the load phase', async () => {
  const gate = createCollaborationRoomActivityGate({ maxActivitiesPerDocument: 1 });
  const lease = gate.admit('auth-gap');
  const startup = createCollaborationRoomStartupActivity({ activity: lease });
  const authResult = await startup.run(async () => 'auth-ok');
  assert.equal(authResult, 'auth-ok');
  await assertActivityError(Promise.resolve().then(() => gate.admit('auth-gap')), 'ROOM_ACTIVITY_BUSY');

  startup.cancel();
  let loadCalled = false;
  await assertActivityError(startup.run(async () => { loadCalled = true; }), 'ROOM_ACTIVITY_CLOSED');
  assert.equal(loadCalled, false, 'a cancelled startup does not begin its next phase');
  await assertActivityError(Promise.resolve().then(() => gate.admit('auth-gap')), 'ROOM_ACTIVITY_BUSY');
  startup.finish();

  const next = gate.admit('auth-gap');
  next.release();
});

test('drain before a phase preserves the gate error and waits for caller finish before releasing its lease', async () => {
  const gate = createCollaborationRoomActivityGate();
  const lease = gate.admit('drained-room');
  const drain = gate.beginDrain('drained-room');
  const startup = createCollaborationRoomStartupActivity({ activity: lease });
  let operationCalled = false;

  await assertActivityError(startup.run(async () => { operationCalled = true; }), 'ROOM_ACTIVITY_DRAINING');
  assert.equal(operationCalled, false);
  let idle = false;
  void drain.idle.then(() => { idle = true; });
  await Promise.resolve();
  assert.equal(idle, false, 'failed admission alone does not finish caller cleanup');
  startup.finish();
  await drain.idle;
  drain.finish();
});

test('success keeps one lease through auth, load, and connected phases until finish', async () => {
  const gate = createCollaborationRoomActivityGate({ maxActivitiesPerDocument: 1 });
  const lease = gate.admit('connected-room');
  let finished = 0;
  const startup = createCollaborationRoomStartupActivity({ activity: lease, onFinished: () => { finished += 1; } });

  assert.equal(await startup.run(async () => 'auth'), 'auth');
  assert.equal(await startup.run(async () => 'loaded'), 'loaded');
  assert.equal(await startup.run(async () => 'connected'), 'connected');
  assert.equal(finished, 0, 'successful phase completion does not release the startup lease');
  await assertActivityError(Promise.resolve().then(() => gate.admit('connected-room')), 'ROOM_ACTIVITY_BUSY');

  startup.finish();
  startup.finish();
  startup.cancel();
  assert.equal(finished, 1);
  const next = gate.admit('connected-room');
  next.release();
});

test('finish during an in-flight phase blocks further phases but waits for actual completion to release', async () => {
  const gate = createCollaborationRoomActivityGate({ maxActivitiesPerDocument: 1 });
  const lease = gate.admit('finish-pending');
  let finished = 0;
  const startup = createCollaborationRoomStartupActivity({ activity: lease, onFinished: () => { finished += 1; } });
  const entered = deferred();
  const complete = deferred();
  const phase = startup.run(async () => { entered.resolve(); await complete.promise; return 'done'; });
  await entered.promise;

  startup.finish();
  assert.equal(finished, 0);
  await assertActivityError(Promise.resolve().then(() => gate.admit('finish-pending')), 'ROOM_ACTIVITY_BUSY');
  complete.resolve();
  await assertActivityError(phase, 'ROOM_ACTIVITY_CLOSED');
  assert.equal(finished, 1);
});

test('nested startup phases remain counted until every underlying operation has settled', async () => {
  const gate = createCollaborationRoomActivityGate({ maxActivitiesPerDocument: 1 });
  const lease = gate.admit('nested-room');
  const startup = createCollaborationRoomStartupActivity({ activity: lease });
  const nestedEntered = deferred();
  const completeNested = deferred();
  const outer = startup.run(async () => {
    await startup.run(async () => {
      nestedEntered.resolve();
      await completeNested.promise;
    });
  });
  await nestedEntered.promise;

  startup.cancel();
  completeNested.resolve();
  await assertActivityError(outer, 'ROOM_ACTIVITY_CLOSED');
  await assertActivityError(Promise.resolve().then(() => gate.admit('nested-room')), 'ROOM_ACTIVITY_BUSY');
  startup.finish();
  const next = gate.admit('nested-room');
  next.release();
});
