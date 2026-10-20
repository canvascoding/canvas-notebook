import assert from 'node:assert/strict';
import { ExtensionConnectionObservations } from '../app/lib/chat/extension-connection-observations';

type State = { accounts: string[]; available: boolean };
const ready = (): State => ({ accounts: ['own-account'], available: true });
const unavailable: State = { accounts: [], available: false };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

async function main() {
  let now = 0, calls = 0;
  const cache = new ExtensionConnectionObservations<State>(() => now, 2, 1024, 60_000, 30);
  assert.equal(cache.get('actor-a:profile-a:revision-1'), undefined);
  const first = deferred<State>();
  const a = cache.refresh('actor-a:profile-a:revision-1', async () => { calls++; return first.promise; }, unavailable);
  const b = cache.refresh('actor-a:profile-a:revision-1', async () => { calls++; return ready(); }, unavailable);
  await Promise.resolve();
  assert.equal(calls, 1);
  first.resolve(ready());
  const [left, right] = await Promise.all([a, b]);
  left.accounts.push('mutated'); right.accounts.length = 0;
  assert.deepEqual(cache.get('actor-a:profile-a:revision-1'), ready());
  assert.equal(cache.get('actor-b:profile-a:revision-1'), undefined);
  assert.equal(cache.get('actor-a:profile-a:revision-2'), undefined);
  now = 60_001;
  assert.equal(cache.get('actor-a:profile-a:revision-1'), undefined);
  console.log('PASS observation reuse coalesces one revision, isolates returned values and expires; keys cannot alias another actor/revision.');

  let failures = 0;
  await cache.refresh('failure', async () => { failures++; throw new Error('provider unavailable'); }, unavailable);
  await cache.refresh('failure', async () => { failures++; return ready(); }, unavailable);
  assert.equal(failures, 1);
  now += 10_001;
  assert.deepEqual(await cache.refresh('failure', async () => { failures++; return ready(); }, unavailable), ready());
  assert.equal(failures, 2);
  await cache.refresh('second', async () => ready(), unavailable);
  await cache.refresh('third', async () => ready(), unavailable);
  assert.equal(cache.get('failure'), undefined);
  assert.deepEqual(cache.get('third'), ready());
  const tiny = new ExtensionConnectionObservations<State>(() => now, 2, 1, 60_000, 30);
  await tiny.refresh('oversize', async () => ready(), unavailable);
  assert.equal(tiny.get('oversize'), undefined);
  console.log('PASS negative observations retry after their short TTL; entry and byte budgets evict or decline retention.');

  const ignored = deferred<State>();
  const timed = new ExtensionConnectionObservations<State>(() => now, 16, 4096, 60_000, 30);
  const pending = Array.from({ length: 8 }, (_, index) => timed.refresh(`held-${index}`, async () => ignored.promise, unavailable));
  let ninthCalled = false;
  assert.deepEqual(await timed.refresh('capacity', async () => { ninthCalled = true; return ready(); }, unavailable), unavailable);
  assert.equal(ninthCalled, false);
  const completed = await Promise.race([
    Promise.all(pending),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Ignored provider AbortSignal retained an observation slot.')), 1000)),
  ]);
  assert(completed.every(value => !value.available));
  assert.deepEqual(await timed.refresh('after-timeout', async () => ready(), unavailable), ready());
  ignored.resolve(ready());
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(timed.get('held-0'), unavailable, 'Late provider completion must not overwrite the timed-out observation.');
  console.log('PASS ignored provider cancellation is bounded, pending slots reopen and late completion cannot resurrect readiness.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
