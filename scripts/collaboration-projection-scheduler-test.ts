import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createCollaborationProjectionScheduler, type CollaborationProjectionRequest } from '../app/lib/collaboration/projection-scheduler';

type Timer = ReturnType<typeof setTimeout>;
type SchedulerInput = Parameters<typeof createCollaborationProjectionScheduler>[0];

// Drain promise continuations without waiting for wall-clock time. Scheduler
// deadlines themselves run only through the injected clock below.
async function settle() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function createClock() {
  let current = 0;
  let nextId = 0;
  const timers = new Map<number, { dueAt: number; callback: () => void }>();
  return {
    now: () => current,
    setTimer(callback: () => void, delayMs: number): Timer {
      const id = ++nextId;
      timers.set(id, { dueAt: current + delayMs, callback });
      return id as unknown as Timer;
    },
    clearTimer(timer: Timer) { timers.delete(timer as unknown as number); },
    async advanceTo(target: number) {
      assert.ok(target >= current, 'the test clock only moves forward');
      await settle();
      for (let count = 0; ; count++) {
        assert.ok(count < 1_000, 'scheduler must not spin on an immediately due job');
        const next = [...timers].filter(([, timer]) => timer.dueAt <= target)
          .sort((a, b) => a[1].dueAt - b[1].dueAt || a[0] - b[0])[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        current = timer.dueAt;
        timer.callback();
        await settle();
      }
      current = target;
      await settle();
    },
  };
}

function gate() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function request(documentId = 'document-a', documentSequence = 1, lifecycleGeneration = 1): CollaborationProjectionRequest {
  return { documentId, documentSequence, lifecycleGeneration };
}

function setup(t: TestContext, options: Partial<Pick<SchedulerInput, 'project' | 'onError' | 'maxConcurrent'>> = {}) {
  const clock = createClock();
  const calls: Array<{ at: number; request: CollaborationProjectionRequest }> = [];
  const errors: Array<{ error: unknown; request: CollaborationProjectionRequest; attempt: number }> = [];
  const scheduler = createCollaborationProjectionScheduler({
    ...clock,
    maxConcurrent: options.maxConcurrent,
    project: async (snapshot) => {
      calls.push({ at: clock.now(), request: { ...snapshot } });
      await options.project?.(snapshot);
    },
    onError: (error, snapshot, attempt) => {
      errors.push({ error, request: { ...snapshot }, attempt });
      options.onError?.(error, snapshot, attempt);
    },
  });
  t.after(() => scheduler.dispose());
  return { clock, scheduler, calls, errors };
}

test('edits coalesce until two seconds of idle and export a copy of the latest request', async (t) => {
  const { clock, scheduler, calls } = setup(t);
  scheduler.enqueue(request());
  await clock.advanceTo(1_500);
  const latest = request('document-a', 2);
  scheduler.enqueue(latest);
  latest.documentSequence = 999;
  await clock.advanceTo(3_499);
  assert.deepEqual(calls, []);
  await clock.advanceTo(3_500);
  assert.deepEqual(calls, [{ at: 3_500, request: request('document-a', 2) }]);
  await clock.advanceTo(20_000);
  assert.equal(calls.length, 1, 'successful projection does not poll or repeat by itself');
});

test('continuous edits cannot postpone projection beyond ten seconds', async (t) => {
  const { clock, scheduler, calls } = setup(t);
  scheduler.enqueue(request());
  for (let sequence = 2; sequence <= 10; sequence++) {
    await clock.advanceTo((sequence - 1) * 1_000);
    scheduler.enqueue(request('document-a', sequence));
  }
  await clock.advanceTo(9_999);
  assert.equal(calls.length, 0);
  await clock.advanceTo(10_000);
  assert.deepEqual(calls, [{ at: 10_000, request: request('document-a', 10) }]);
});

test('recovery scans of the same or older sequence do not postpone idle projection', async (t) => {
  const { clock, scheduler, calls } = setup(t);
  scheduler.enqueue(request('document-a', 3));
  for (const at of [500, 1_000, 1_999]) {
    await clock.advanceTo(at);
    scheduler.enqueue(request('document-a', 3));
    scheduler.enqueue(request('document-a', 2));
  }
  await clock.advanceTo(2_000);
  assert.deepEqual(calls, [{ at: 2_000, request: request('document-a', 3) }]);
});

test('a recovery request can be projected immediately without waiting for idle', async (t) => {
  const { clock, scheduler, calls } = setup(t);
  scheduler.enqueue(request(), { immediately: true });
  await clock.advanceTo(0);
  assert.deepEqual(calls, [{ at: 0, request: request() }]);
});

test('each document has one export in flight and coalesces edits made during it', async (t) => {
  const first = gate();
  const { clock, scheduler, calls } = setup(t, {
    project: (snapshot) => snapshot.documentSequence === 1 ? first.promise : Promise.resolve(),
  });
  scheduler.enqueue(request());
  await clock.advanceTo(2_000);
  scheduler.enqueue(request('document-a', 2));
  await clock.advanceTo(3_000);
  scheduler.enqueue(request('document-a', 3));
  await clock.advanceTo(20_000);
  assert.equal(calls.length, 1, 'another global worker cannot export the same document concurrently');
  first.resolve();
  await clock.advanceTo(20_000);
  assert.deepEqual(calls, [
    { at: 2_000, request: request() },
    { at: 20_000, request: request('document-a', 3) },
  ]);
});

test('global concurrency defaults to two and released slots serve waiting documents', async (t) => {
  const gates = new Map(['a', 'b', 'c', 'd'].map((id) => [id, gate()]));
  const { clock, scheduler, calls } = setup(t, { project: (snapshot) => gates.get(snapshot.documentId)!.promise });
  for (const id of gates.keys()) scheduler.enqueue(request(id));
  await clock.advanceTo(2_000);
  assert.deepEqual(calls.map((call) => call.request.documentId), ['a', 'b']);
  await clock.advanceTo(10_000);
  assert.equal(calls.length, 2, 'slow exports cannot exceed the global worker bound');
  gates.get('a')!.resolve();
  await clock.advanceTo(10_000);
  assert.deepEqual(calls.map((call) => call.request.documentId), ['a', 'b', 'c']);
  gates.get('b')!.resolve();
  await clock.advanceTo(10_000);
  assert.deepEqual(calls.map((call) => call.request.documentId), ['a', 'b', 'c', 'd']);
  gates.get('c')!.resolve();
  gates.get('d')!.resolve();
  await settle();
});

test('a new lifecycle generation waits for the old export and suppresses stale queued requests', async (t) => {
  const first = gate();
  const { clock, scheduler, calls } = setup(t, {
    project: (snapshot) => snapshot.lifecycleGeneration === 1 ? first.promise : Promise.resolve(),
  });
  scheduler.enqueue(request('document-a', 20));
  await clock.advanceTo(2_000);
  scheduler.enqueue(request('document-a', 1, 2));
  scheduler.enqueue(request('document-a', 999, 1), { immediately: true });
  scheduler.enqueue(request('document-a', 0, 2), { immediately: true });
  await clock.advanceTo(5_000);
  assert.equal(calls.length, 1);
  first.resolve();
  await clock.advanceTo(5_000);
  assert.deepEqual(calls.map((call) => call.request), [request('document-a', 20), request('document-a', 1, 2)]);
});

test('a failed export cannot replace a newer generation already waiting', async (t) => {
  const first = gate();
  const failure = new Error('old generation export failed');
  const { clock, scheduler, calls, errors } = setup(t, {
    project: (snapshot) => snapshot.lifecycleGeneration === 1 ? first.promise : Promise.resolve(),
  });
  scheduler.enqueue(request('document-a', 20));
  await clock.advanceTo(2_000);
  scheduler.enqueue(request('document-a', 1, 2));
  await clock.advanceTo(5_000);
  first.reject(failure);
  await clock.advanceTo(5_000);
  await clock.advanceTo(400_000);
  assert.deepEqual(calls.map((call) => call.request), [request('document-a', 20), request('document-a', 1, 2)]);
  assert.deepEqual(errors, [{ error: failure, request: request('document-a', 20), attempt: 1 }]);
});

test('older generations arriving after successful projection remain ignored', async (t) => {
  const { clock, scheduler, calls } = setup(t);
  scheduler.enqueue(request('document-a', 1, 2));
  await clock.advanceTo(2_000);
  scheduler.enqueue(request('document-a', 999, 1), { immediately: true });
  await clock.advanceTo(10_000);
  assert.deepEqual(calls, [{ at: 2_000, request: request('document-a', 1, 2) }]);
});

test('failed projections retry after 1, 2, 4, 8 seconds, then every five minutes despite repeated scans', async (t) => {
  const failure = new Error('projection unavailable');
  const { clock, scheduler, calls, errors } = setup(t, { project: async () => { throw failure; } });
  scheduler.enqueue(request());
  const expectedTimes = [2_000, 3_000, 5_000, 9_000, 17_000, 317_000, 617_000];
  for (const [index, at] of expectedTimes.entries()) {
    await clock.advanceTo(at - 1);
    scheduler.enqueue(request(), { immediately: true });
    scheduler.enqueue(request());
    assert.equal(calls.length, index, 'duplicate scans do not bypass retry backoff');
    await clock.advanceTo(at);
    assert.equal(calls.length, index + 1, 'duplicate scans do not postpone retry');
  }
  assert.deepEqual(calls.map((call) => call.at), expectedTimes);
  assert.deepEqual(errors.map((entry) => entry.attempt), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(errors.every((entry) => entry.error === failure));
});

test('new edits escape long retry backoff with a fresh debounce and reset retry attempts', async (t) => {
  const { clock, scheduler, calls, errors } = setup(t, { project: async () => { throw new Error('retry'); } });
  scheduler.enqueue(request());
  await clock.advanceTo(100_000);
  assert.deepEqual(calls.map((call) => call.at), [2_000, 3_000, 5_000, 9_000, 17_000]);
  scheduler.enqueue(request('document-a', 2));
  await clock.advanceTo(101_999);
  assert.equal(calls.length, 5, 'a fresh edit is debounced instead of flushed on every keystroke');
  await clock.advanceTo(102_000);
  assert.deepEqual(calls.at(-1), { at: 102_000, request: request('document-a', 2) });
  assert.equal(errors.at(-1)?.attempt, 1);
  await clock.advanceTo(103_000);
  assert.deepEqual(calls.at(-1), { at: 103_000, request: request('document-a', 2) });
  assert.equal(errors.at(-1)?.attempt, 2);
});

test('diagnostic callback failures cannot stop retry or another document', async (t) => {
  const { clock, scheduler, calls, errors } = setup(t, {
    project: async (snapshot) => { if (snapshot.documentId === 'broken') throw new Error('projection'); },
    onError: () => { throw new Error('diagnostics'); },
  });
  scheduler.enqueue(request('broken'));
  scheduler.enqueue(request('healthy'));
  await clock.advanceTo(3_000);
  assert.deepEqual(calls.map((call) => [call.at, call.request.documentId]), [
    [2_000, 'broken'], [2_000, 'healthy'], [3_000, 'broken'],
  ]);
  assert.equal(errors.length, 2);
});

test('dispose drops queued work and rejects future enqueues', async (t) => {
  const { clock, scheduler, calls } = setup(t);
  scheduler.enqueue(request());
  await clock.advanceTo(1_000);
  scheduler.dispose();
  scheduler.enqueue(request('document-b'), { immediately: true });
  await clock.advanceTo(1_000_000);
  assert.deepEqual(calls, []);
});

for (const fails of [false, true]) {
  test(`dispose lets a running export ${fails ? 'fail' : 'finish'} without starting queued work or retries`, async (t) => {
    const running = gate();
    let completed = false;
    const { clock, scheduler, calls, errors } = setup(t, {
      maxConcurrent: 1,
      project: async () => { try { await running.promise; } finally { completed = true; } },
    });
    scheduler.enqueue(request('document-a'));
    scheduler.enqueue(request('document-b'));
    await clock.advanceTo(2_000);
    scheduler.dispose();
    assert.equal(completed, false, 'dispose does not interrupt an existing filesystem operation');
    if (fails) running.reject(new Error('finished after disposal'));
    else running.resolve();
    await clock.advanceTo(1_000_000);
    assert.equal(completed, true);
    assert.deepEqual(calls, [{ at: 2_000, request: request('document-a') }]);
    assert.deepEqual(errors, [], 'disposal stops future diagnostic/retry callbacks');
  });
}
