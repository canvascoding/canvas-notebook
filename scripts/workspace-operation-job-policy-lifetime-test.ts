import assert from 'node:assert/strict';
import { withWorkspaceOperationJobPolicyLifetime as phase } from '../app/lib/workspaces/workspace-operation-job-policy-lifetime';

// Mechanical callback contract only; genuine principal/SQL acceptance is
// exercised separately by the native owner and API-key job fixtures.
type Access = Readonly<{ assertCurrent: () => Promise<void> }>;
const failure = (reason: string) => new Error(`POLICY_${reason.toUpperCase()}`);
const is = (expected: Error) => (error: unknown) => error === expected;
const has = (message: string) => (error: unknown) => error instanceof Error && error.message === message;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function input(check: () => Promise<void>, options: {
  assertCoreCurrent?: () => Promise<void>; closingFailure?: (error: unknown) => void;
} = {}) {
  return { check, assertCoreCurrent: options.assertCoreCurrent ?? (async () => undefined),
    access: (assertCurrent: () => Promise<void>): Access => Object.freeze({ assertCurrent }),
    error: failure, closingFailure: options.closingFailure ?? (() => undefined) };
}
let groups = 0;
async function test(name: string, run: () => Promise<void>) {
  await run(); groups++; console.log(`Job policy lifetime passed: ${name}`);
}
async function main() {
  await test('an awaited current-policy assertion preserves the exact callback result', async () => {
    const result = Object.freeze({ receipt: 'mechanical-result' });
    assert.equal(await phase(input(async () => undefined), async access => {
      assert(Object.isFrozen(access)); await access.assertCurrent(); return result;
    }), result);
  });
  await test('a caught authority withdrawal cannot turn the phase into success', async () => {
    const denied = new Error('CURRENT_AUTHORITY_WITHDRAWN'); let withdrawn = false;
    await assert.rejects(phase(input(async () => { if (withdrawn) throw denied; }), async access => {
      withdrawn = true; await assert.rejects(access.assertCurrent(), is(denied)); return 'must not succeed';
    }), is(denied));
  });
  await test('unawaited validation is drained and cannot publish callback success', async () => {
    const entered = deferred(), release = deferred(); let block = false, settled = false;
    const result = phase(input(async () => { if (block) { entered.resolve(); await release.promise; } }), async access => {
      block = true; void access.assertCurrent().catch(() => undefined); return 'must not succeed';
    });
    const observed = result.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    void observed.then(() => { settled = true; });
    await entered.promise; await Promise.resolve(); assert.equal(settled, false);
    release.resolve(); assert(has('POLICY_DETACHED')((await observed).error));
  });
  await test('concurrent assertions poison the phase even when their errors are handled', async () => {
    const entered = deferred(), release = deferred(); let block = false;
    await assert.rejects(phase(input(async () => { if (block) { entered.resolve(); await release.promise; } }), async access => {
      block = true; const first = access.assertCurrent(); await entered.promise;
      await assert.rejects(access.assertCurrent(), has('POLICY_REENTRANT'));
      release.resolve(); await first.catch(() => undefined); return 'must not succeed';
    }), has('POLICY_REENTRANT'));
  });
  await test('retained assertions enter the genuine Core closing check and cannot revive a callback', async () => {
    let retained: Access | undefined, coreChecked = false, closing: unknown;
    await phase(input(async () => undefined, { assertCoreCurrent: async () => { coreChecked = true; },
      closingFailure: error => { closing ??= error; } }), async access => { retained = access; });
    assert(retained); await assert.rejects(retained.assertCurrent(), has('POLICY_REQUIRED'));
    assert.equal(coreChecked, true); assert(has('POLICY_REQUIRED')(closing));
  });
  await test('the exact Core closing failure is preserved', async () => {
    let retained: Access | undefined, closing: unknown; const denied = new Error('CORE_CLOSED');
    await phase(input(async () => undefined, { assertCoreCurrent: async () => { throw denied; },
      closingFailure: error => { closing ??= error; } }), async access => { retained = access; });
    assert(retained); await assert.rejects(retained.assertCurrent(), is(denied)); assert.equal(closing, denied);
  });
  await test('callback failure waits for pending validation and preserves its original error', async () => {
    const entered = deferred(), release = deferred(), original = new Error('CALLBACK_FAILED'); let block = false, settled = false;
    const result = phase(input(async () => { if (block) { entered.resolve(); await release.promise; } }), async access => {
      block = true; void access.assertCurrent().catch(() => undefined); throw original;
    });
    const observed = result.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    void observed.then(() => { settled = true; });
    await entered.promise; await Promise.resolve(); assert.equal(settled, false);
    release.resolve(); assert.equal((await observed).error, original);
  });
  console.log(`Job policy lifetime: ${groups} mechanical contract groups passed; no authentication or native owner claim.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
