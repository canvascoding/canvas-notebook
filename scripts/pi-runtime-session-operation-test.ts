import assert from 'node:assert/strict';

import { withPiSessionOperationLock } from '../app/lib/pi/session-operation-lock';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function main() {
  const promptEntered = deferred();
  const releasePrompt = deferred();
  const firstOrder: string[] = [];
  let running = false;

  const promptFirst = withPiSessionOperationLock('prompt-first', 'user', async () => {
    firstOrder.push('prompt:prepare');
    promptEntered.resolve();
    await releasePrompt.promise;
    running = true;
    firstOrder.push('prompt:start');
  });
  await promptEntered.promise;

  const rejectedChange = withPiSessionOperationLock('prompt-first', 'user', async () => {
    firstOrder.push('change:check');
    assert.equal(running, true, 'the prompt must start before the queued idle check');
    return running ? 'busy' : 'changed';
  });
  await Promise.resolve();
  assert.deepEqual(firstOrder, ['prompt:prepare'], 'the model change must wait while a prompt is preparing');
  releasePrompt.resolve();
  await promptFirst;
  assert.equal(await rejectedChange, 'busy');
  assert.deepEqual(firstOrder, ['prompt:prepare', 'prompt:start', 'change:check']);

  const changeEntered = deferred();
  const releaseChange = deferred();
  const secondOrder: string[] = [];
  let generation = 1;

  const changeFirst = withPiSessionOperationLock('change-first', 'user', async () => {
    secondOrder.push('change:check');
    changeEntered.resolve();
    await releaseChange.promise;
    generation = 2;
    secondOrder.push('change:invalidate');
  });
  await changeEntered.promise;

  const queuedPrompt = withPiSessionOperationLock('change-first', 'user', async () => {
    secondOrder.push(`prompt:generation-${generation}`);
  });
  await Promise.resolve();
  assert.deepEqual(secondOrder, ['change:check'], 'a prompt must not start during a reserved model change');
  releaseChange.resolve();
  await Promise.all([changeFirst, queuedPrompt]);
  assert.deepEqual(secondOrder, ['change:check', 'change:invalidate', 'prompt:generation-2']);

  await assert.rejects(
    withPiSessionOperationLock('release-after-error', 'user', async () => {
      throw new Error('expected');
    }),
    /expected/,
  );
  let recovered = false;
  await withPiSessionOperationLock('release-after-error', 'user', async () => {
    recovered = true;
  });
  assert.equal(recovered, true, 'a failed operation must release the session lock');

  console.log('pi-runtime-session-operation-test: ok');
}

void main();
