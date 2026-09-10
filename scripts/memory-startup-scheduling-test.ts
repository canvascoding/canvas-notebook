import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { loadIsolatedModule } from './helpers/isolated-source-module';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  type Timer = { callback: () => void; millis: number; unref: () => void };
  type Handle = { started: boolean; trigger: () => void; stop: () => void };
  const timers = new Set<Timer>();
  const errors: string[] = [];
  let reads = 0;
  let cycles = 0;
  let failCycle = false;
  let readDue = async (): Promise<number | null> => null;
  const runtime = loadIsolatedModule<{ initializeMemoryReviewWorkerRuntime: () => Handle }>('app/lib/memory/review-worker.ts', {
    'server-only': {}, 'node:crypto': {},
    '@/app/lib/agent-runtime-policy/catalog-store': {},
    '@/app/lib/agent-runtime-policy/provider-runtime': {},
    '@/app/lib/agents/registry': {}, '@/app/lib/pi/message-projection': {},
    '@/app/lib/pi/multimodal-preparation': {}, '@/app/lib/pi/session-workspace-context': {},
    '@/app/lib/pi/usage-events': {}, '@/app/lib/pi/context-budget': {}, '@/app/lib/user-preferences': {},
    './service': {
      nextMemoryReviewDueAt: async () => { reads++; return readDue(); },
      scheduleUnreviewedMemorySessions: async () => { if (failCycle) throw new Error('private cycle failure'); },
      claimDueMemoryReviewJob: async () => null,
      runMemoryMaintenanceCycle: async () => { cycles++; },
    },
    './constants': { MEMORY_MANAGER_AGENT_ID: 'fixture' },
    './contract': { MEMORY_REVIEW_OUTPUT_TOKENS: 10 }, './categories': {},
    './review-runtime': { memoryReviewErrorCode: () => 'database_unavailable' },
    './review-worker-config': { memoryReviewWorkerAvailability: () => ({ available: true }) },
  }, {
    globalThis: {},
    console: { info: () => {}, warn: () => {}, error: (...args: unknown[]) => { errors.push(JSON.stringify(args)); } },
    setTimeout: (callback: Timer['callback'], millis: number) => {
      const timer = { callback, millis, unref() {} };
      timers.add(timer);
      return timer;
    },
    clearTimeout: (timer: Timer) => { timers.delete(timer); },
  });
  return {
    initialize: runtime.initializeMemoryReviewWorkerRuntime,
    timers, errors,
    reads: () => reads, cycles: () => cycles,
    setReadDue: (callback: typeof readDue) => { readDue = callback; },
    failCycle: () => { failCycle = true; },
    fire: async (expectedMillis?: number) => {
      assert.equal(timers.size, 1, 'exactly one timer may exist');
      const timer = [...timers][0];
      if (expectedMillis !== undefined) assert.equal(timer.millis, expectedMillis);
      timers.delete(timer);
      timer.callback();
      await delay(0);
    },
  };
}

async function main() {
  const unhandled: unknown[] = [];
  const listener = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', listener);
  try {
    const test = fixture();
    const initial = deferred<number | null>();
    test.setReadDue(() => initial.promise);
    const owner = test.initialize();
    assert.equal(owner.started, true);
    assert.equal(test.initialize().started, false);
    owner.trigger(); owner.trigger();
    assert.equal(test.reads(), 1, 'coalesce triggers while the scheduling query is pending');
    initial.reject(new Error('private connection failure'));
    await delay(0);
    assert.equal(test.errors.length, 1);
    test.setReadDue(async () => { throw new Error('private connection failure'); });
    for (const backoff of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
      const reads = test.reads();
      owner.trigger(); owner.trigger();
      assert.equal(test.reads(), reads, 'manual triggers must not bypass an active backoff');
      await test.fire(backoff);
    }
    test.setReadDue(async () => Date.now() + 5_000);
    await test.fire(30_000);
    await test.fire(0); // Honor the pending trigger once DB discovery recovers.
    assert.equal(test.cycles(), 1, 'the worker must resume, not just log and stop');
    assert.equal(test.timers.size, 1);
    test.failCycle();
    test.setReadDue(async () => { throw new Error('private rescheduling failure'); });
    await test.fire();
    assert.equal([...test.timers][0].millis, 1_000, 'successful scheduling resets backoff before a later failure');
    assert.ok(test.errors.every((error) => !error.includes('private')));
    const duplicate = test.initialize();
    duplicate.stop();
    assert.equal(test.timers.size, 0, 'a reused handle must also cancel the timer');
    owner.stop();

    for (const rejects of [false, true]) {
      const stopped = fixture();
      const oldQuery = deferred<number | null>();
      stopped.setReadDue(() => oldQuery.promise);
      const oldOwner = stopped.initialize();
      oldOwner.stop();
      const newQuery = deferred<number | null>();
      stopped.setReadDue(() => newQuery.promise);
      const newOwner = stopped.initialize();
      assert.equal(newOwner.started, true);
      if (rejects) oldQuery.reject(new Error('old generation failure'));
      else oldQuery.resolve(0);
      await delay(0);
      assert.equal(stopped.timers.size, 0, 'a stopped/replaced generation must not schedule a timer');
      assert.equal(stopped.errors.length, 0);
      newQuery.resolve(0);
      await delay(0);
      assert.equal(stopped.timers.size, 1);
      newOwner.stop();
      assert.equal(stopped.timers.size, 0);
    }
    await delay(0);
    assert.deepEqual(unhandled, []);
    console.log('Memory scheduling: initial/trigger/reschedule failures, capped backoff, recovery, coalescing and stopped generations passed.');
  } finally {
    process.removeListener('unhandledRejection', listener);
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
