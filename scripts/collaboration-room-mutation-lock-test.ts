import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

import {
  acquireCollaborationRoomMutationLock,
  createCollaborationRoomMutationLock,
  withCollaborationRoomMutationLock,
} from '../app/lib/collaboration/room-mutation-lock';

type LockModule = typeof import('../app/lib/collaboration/room-mutation-lock');

async function compileLockModule(): Promise<LockModule> {
  const filename = path.resolve('app/lib/collaboration/room-mutation-lock.ts');
  const exports: Record<string, unknown> = {};
  const compiledModule = { exports };
  const compiled = ts.transpileModule(await readFile(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  new Function('module', 'exports', compiled)(compiledModule, exports);
  return exports as LockModule;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function rejectsWithMessage(promise: Promise<unknown>, message: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, message);
    return true;
  });
}

async function testFifoAndStaleRelease() {
  const lock = createCollaborationRoomMutationLock();
  const room = {};
  const order: string[] = [];
  const releaseFirst = await lock.acquire(room);
  const secondPromise = lock.acquire(room);
  const thirdPromise = lock.acquire(room);

  releaseFirst();
  const releaseSecond = await secondPromise;
  order.push('second');
  releaseFirst();
  let thirdAcquired = false;
  void thirdPromise.then(() => { thirdAcquired = true; });
  await Promise.resolve();
  assert.equal(thirdAcquired, false, 'a stale release cannot release the next owner');

  releaseSecond();
  const releaseThird = await thirdPromise;
  order.push('third');
  releaseThird();
  assert.deepEqual(order, ['second', 'third']);
}

async function testIndependentRoomIdentity() {
  const lock = createCollaborationRoomMutationLock();
  const firstRoom = {};
  const secondRoom = {};
  const releaseFirstRoom = await lock.acquire(firstRoom);
  const releaseSecondRoom = await lock.acquire(secondRoom);

  let sameRoomAcquired = false;
  const sameRoomPromise = lock.acquire(firstRoom).then((release) => {
    sameRoomAcquired = true;
    release();
  });
  await Promise.resolve();
  assert.equal(sameRoomAcquired, false, 'the exact room object remains locked');
  releaseSecondRoom();
  releaseFirstRoom();
  await sameRoomPromise;
  assert.equal(sameRoomAcquired, true);
}

async function testTimeoutAndQueueCleanup() {
  const lock = createCollaborationRoomMutationLock({
    maxRoomWaiters: 1,
    maxTotalWaiters: 1,
    acquireTimeoutMs: 10,
  });
  const room = {};
  const releaseOwner = await lock.acquire(room);
  await rejectsWithMessage(lock.acquire(room), /Timed out/u);

  const nextWaiter = lock.acquire(room);
  releaseOwner();
  const releaseNext = await nextWaiter;
  releaseNext();
}

async function testTimedOutHeadKeepsFollowingWaitersFifoAcrossRooms() {
  const lock = createCollaborationRoomMutationLock({
    maxRoomWaiters: 2,
    maxTotalWaiters: 3,
    acquireTimeoutMs: 120,
  });
  const roomA = {};
  const roomB = {};
  const releaseA = await lock.acquire(roomA);
  const timedOutHead = lock.acquire(roomA);
  const headRejection = rejectsWithMessage(timedOutHead, /Timed out/u);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const followerA = lock.acquire(roomA);
  const releaseB = await lock.acquire(roomB);
  const followerB = lock.acquire(roomB);
  await headRejection;

  const laterA = lock.acquire(roomA);
  releaseA();
  const releaseFollowerA = await followerA;
  releaseFollowerA();
  const releaseLaterA = await laterA;
  releaseLaterA();

  releaseB();
  const releaseFollowerB = await followerB;
  releaseFollowerB();
}

async function testQueueCapsAndGlobalCleanup() {
  const lock = createCollaborationRoomMutationLock({
    maxRoomWaiters: 1,
    maxTotalWaiters: 2,
    acquireTimeoutMs: 100,
  });
  const roomA = {};
  const roomB = {};
  const roomC = {};
  const releaseA = await lock.acquire(roomA);
  const waiterA = lock.acquire(roomA);
  await rejectsWithMessage(lock.acquire(roomA), /queue is full/u);

  const releaseB = await lock.acquire(roomB);
  const waiterB = lock.acquire(roomB);
  const releaseC = await lock.acquire(roomC);
  await rejectsWithMessage(lock.acquire(roomC), /queue is full/u);

  releaseA();
  const releaseWaiterA = await waiterA;
  releaseWaiterA();
  releaseB();
  const releaseWaiterB = await waiterB;
  releaseWaiterB();
  releaseC();

  const releaseAfterCleanup = await lock.acquire(roomC);
  releaseAfterCleanup();
}

async function testWrapperInterleavingAndFailureRelease() {
  const room = {};
  const gate = deferred();
  const events: string[] = [];
  const first = withCollaborationRoomMutationLock(room, async () => {
    events.push('first:start');
    await gate.promise;
    events.push('first:end');
    throw new Error('operation failed');
  });
  const second = withCollaborationRoomMutationLock(room, () => {
    events.push('second');
    return 42;
  });

  await Promise.resolve();
  assert.deepEqual(events, ['first:start']);
  gate.resolve();
  await assert.rejects(first, /operation failed/u);
  assert.equal(await second, 42);
  assert.deepEqual(events, ['first:start', 'first:end', 'second']);
}

async function testWrapperReleasesAfterSynchronousThrow() {
  const room = {};
  const first = withCollaborationRoomMutationLock(room, () => {
    throw new Error('synchronous failure');
  });
  const second = withCollaborationRoomMutationLock(room, () => 'released');

  await assert.rejects(first, /synchronous failure/u);
  assert.equal(await second, 'released');
}

async function testSeparatelyCompiledBundlesShareTheGlobalLock() {
  const firstBundle = await compileLockModule();
  const secondBundle = await compileLockModule();
  assert.notStrictEqual(firstBundle, secondBundle, 'each bundle is evaluated independently');

  const room = {};
  const releaseFirst = await firstBundle.acquireCollaborationRoomMutationLock(room);
  let secondAcquired = false;
  const secondWaiter = secondBundle.acquireCollaborationRoomMutationLock(room).then((release) => {
    secondAcquired = true;
    release();
  });
  await Promise.resolve();
  assert.equal(secondAcquired, false, 'separate module evaluations share the process-global room state');
  releaseFirst();
  await secondWaiter;
  assert.equal(secondAcquired, true);

  const releaseFromOriginal = await acquireCollaborationRoomMutationLock(room);
  releaseFromOriginal();
}

async function testRejectsUnsafeAndOverflowingLimits() {
  assert.throws(
    () => createCollaborationRoomMutationLock({ maxTotalWaiters: Number.MAX_SAFE_INTEGER + 1 }),
    /safe integer/u,
  );
  assert.throws(
    () => createCollaborationRoomMutationLock({ acquireTimeoutMs: 2_147_483_648 }),
    /must not exceed/u,
  );
}

async function testCriticalSectionDoesNotAutoRelease() {
  const lock = createCollaborationRoomMutationLock({ acquireTimeoutMs: 5 });
  const room = {};
  const releaseOwner = await lock.acquire(room);
  await new Promise((resolve) => setTimeout(resolve, 15));
  let waitingAcquired = false;
  const waiting = lock.acquire(room).then((release) => {
    waitingAcquired = true;
    release();
  });
  await Promise.resolve();
  assert.equal(waitingAcquired, false, 'the timeout applies to waiters, never the current owner');
  releaseOwner();
  await waiting;
}

async function main() {
  await testFifoAndStaleRelease();
  await testIndependentRoomIdentity();
  await testTimeoutAndQueueCleanup();
  await testTimedOutHeadKeepsFollowingWaitersFifoAcrossRooms();
  await testQueueCapsAndGlobalCleanup();
  await testWrapperInterleavingAndFailureRelease();
  await testWrapperReleasesAfterSynchronousThrow();
  await testSeparatelyCompiledBundlesShareTheGlobalLock();
  await testRejectsUnsafeAndOverflowingLimits();
  await testCriticalSectionDoesNotAutoRelease();
  console.log('collaboration room mutation lock test passed (10 scenarios)');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
