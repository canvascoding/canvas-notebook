import assert from 'node:assert/strict';
import { withOwnedTestCleanup } from '../tests/helpers/owned-test-cleanup';

async function capture(body: () => Promise<unknown>): Promise<unknown> {
  let failed = false;
  let error: unknown;
  try { await body(); } catch (caught) { failed = true; error = caught; }
  assert.equal(failed, true, 'A body or cleanup failure must never become a pass.');
  return error;
}

async function main(): Promise<void> {
  const calls: string[] = [];
  const receipt = { pid: 42, exitCode: 1, signal: null, exitVerified: true };
  const primary = Object.assign(new Error('Body failed.'), { ownedChildReceipt: receipt });
  const close = new Error('Context close failed.');
  const observer = new Error('Strict observer failed.');
  const combined = await capture(() => withOwnedTestCleanup(async () => { throw primary; }, [
    { label: 'page', run: () => { calls.push('page'); } },
    { label: 'context', run: () => { calls.push('context'); throw close; } },
    { label: 'observer', run: () => { calls.push('observer'); throw observer; } },
  ]));
  assert(combined instanceof AggregateError);
  assert.deepEqual(calls, ['page', 'context', 'observer']);
  assert.equal(combined.errors[0], primary);
  assert.equal(combined.errors[1].cause, close);
  assert.equal(combined.errors[2].cause, observer);
  assert.equal((combined as AggregateError & { ownedChildReceipt: unknown }).ownedChildReceipt, receipt);

  const cleanupOnly = await capture(() => withOwnedTestCleanup(async () => 'success', [
    { label: 'delete', run: () => { throw close; } },
  ]));
  assert(cleanupOnly instanceof AggregateError);
  assert.equal(cleanupOnly.errors.length, 1);
  assert.equal(cleanupOnly.errors[0].cause, close);
  assert.equal(await capture(() => withOwnedTestCleanup(async () => { throw undefined; }, [])), undefined);
  const undefinedWithCleanup = await capture(() => withOwnedTestCleanup(async () => { throw undefined; }, [
    { label: 'observer', run: () => { throw observer; } },
  ]));
  assert(undefinedWithCleanup instanceof AggregateError);
  assert.equal(undefinedWithCleanup.errors.length, 2);
  assert.equal(undefinedWithCleanup.errors[0], undefined);
  assert.equal(undefinedWithCleanup.errors[1].cause, observer);
  assert.equal(await withOwnedTestCleanup(async () => 17, [{ label: 'close', run: () => {} }]), 17);
  assert.equal(await capture(() => withOwnedTestCleanup(async () => { throw primary; }, [
    { label: 'close', run: () => {} },
  ])), primary);
  console.info('Owned test cleanup contracts passed: primary, every cleanup, strict observer, undefined rejection and child receipt.');
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
