import assert from 'node:assert/strict';

import { runWebSocketSessionAction } from '../server/websocket-session-queue';

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function main() {
  const firstStarted = createDeferred();
  const allowFirstToFinish = createDeferred();
  const order: string[] = [];

  const first = runWebSocketSessionAction('user-1', 'session-1', async () => {
    order.push('first:start');
    firstStarted.resolve();
    await allowFirstToFinish.promise;
    order.push('first:end');
  });

  await firstStarted.promise;

  const second = runWebSocketSessionAction('user-1', 'session-1', async () => {
    order.push('second:start');
    order.push('second:end');
  });

  await Promise.resolve();
  assert.deepEqual(order, ['first:start']);

  allowFirstToFinish.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end']);

  const parallelStarted = createDeferred();
  const parallelFinished = createDeferred();
  let otherSessionRan = false;

  const blockedSession = runWebSocketSessionAction('user-1', 'session-1', async () => {
    parallelStarted.resolve();
    await parallelFinished.promise;
  });

  await parallelStarted.promise;
  await runWebSocketSessionAction('user-1', 'session-2', async () => {
    otherSessionRan = true;
  });
  assert.equal(otherSessionRan, true);

  parallelFinished.resolve();
  await blockedSession;

  let recoveredAfterFailure = false;
  await assert.rejects(
    runWebSocketSessionAction('user-1', 'session-3', async () => {
      throw new Error('expected failure');
    }),
    /expected failure/,
  );
  await runWebSocketSessionAction('user-1', 'session-3', async () => {
    recoveredAfterFailure = true;
  });
  assert.equal(recoveredAfterFailure, true);

  console.log('websocket-session-queue-test: ok');
}

void main();
