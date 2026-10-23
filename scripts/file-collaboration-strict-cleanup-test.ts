import assert from 'node:assert/strict';
import type { SqlConnection } from '../app/lib/db';
import { setFileCollaborationConnectionFactoryForTests, withFileCollaborationTransaction } from '../app/lib/files/collaboration-repository/transaction';
import { WorkspaceFileLifecycleBusyError } from '../app/lib/files/workspace-file-lifecycle-guard';
import { assertExcalidrawLifecycleAvailable, ExcalidrawLifecycleUnavailableError } from '../app/lib/excalidraw-collaboration/lifecycle-availability';

// Mechanical transaction/connection fault tests using the actual shared helper
// and actual Busy error classes. The controlled SqlConnection is not PostgreSQL
// and establishes no lock, authenticated principal, durable write or pool proof.
type Outcome<T> = { value: T } | { error: unknown };
type Command = 'BEGIN' | 'COMMIT' | 'ROLLBACK';
let completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
function connection(faults: Partial<Record<Command, Error>> & { acquire?: Error; close?: Error; synchronousClose?: boolean;
  closeGate?: { entered: ReturnType<typeof barrier>; release: ReturnType<typeof barrier> } } = {}) {
  const trace: string[] = [], closeArguments: Array<Error | undefined> = [];
  const sql: SqlConnection = {
    get: command => {
      if (!faults.acquire) assert.fail('No simulated SQL results are part of this cleanup test.');
      assert.match(command, /^SELECT pg_(?:try_)?advisory_xact_lock\(/u); trace.push('acquire-fault'); throw faults.acquire;
    },
    all: () => assert.fail('No simulated SQL results are part of this cleanup test.'),
    run: async command => {
      if (command === "SET LOCAL lock_timeout='4s'" || command === "SET LOCAL statement_timeout='5s'") { trace.push(command); return; }
      assert(command === 'BEGIN' || command === 'COMMIT' || command === 'ROLLBACK'); trace.push(command);
      const error = faults[command]; if (error) throw error;
    },
    close: discard => {
      trace.push('close'); closeArguments.push(discard);
      if (faults.synchronousClose && faults.close) throw faults.close;
      return (async () => {
        if (faults.closeGate) { faults.closeGate.entered.resolve(); await faults.closeGate.release.promise; }
        if (faults.close) throw faults.close;
      })();
    },
  };
  return { sql, trace, closeArguments, open: async () => { trace.push('open'); return sql; } };
}
const busy = () => new ExcalidrawLifecycleUnavailableError(new WorkspaceFileLifecycleBusyError());
function terminal(error: unknown, causes: readonly Error[]): asserts error is AggregateError {
  assert(error instanceof AggregateError, 'Cleanup uncertainty must produce a terminal aggregate, not an ordinary Busy.');
  assert(!(error instanceof ExcalidrawLifecycleUnavailableError)); assert(!(error instanceof WorkspaceFileLifecycleBusyError));
  assert.equal(Object.getOwnPropertyDescriptor(error, 'code')?.value, undefined);
  assert.equal(error.errors.length, causes.length);
  causes.forEach((cause, index) => assert.equal(error.errors[index], cause, 'Every actual failure must retain its original identity and order.'));
}
async function outcome<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(value => ({ value }), error => ({ error }));
}
async function awaitCloseEntry(entered: ReturnType<typeof barrier>, pending: Promise<unknown>): Promise<void> {
  const first = await Promise.race([entered.promise.then(() => 'close' as const), pending.then(() => 'settled' as const)]);
  assert.equal(first, 'close', 'The helper must invoke close before settling; missing close must fail rather than hang the test.');
}

export async function fileCollaborationStrictCleanupTest(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  let groups = 0;
  const group = async (name: string, operation: () => Promise<void>) => {
    await operation(); console.log(`PASS strict-file-collaboration-cleanup ${++groups}: ${name}`);
  };
  await group('strict success returns the exact callback value only after successful close', async () => {
    const entered = barrier(), release = barrier(), c = connection({ closeGate: { entered, release } }), expected = Object.freeze({ callback: 'exact-value' });
    let settled = false;
    const pending = outcome(withFileCollaborationTransaction(async transaction => {
      assert.equal(transaction, c.sql); c.trace.push('callback'); return expected;
    }, c.open, { strictCleanup: true })).then(result => { settled = true; return result; });
    try {
      await awaitCloseEntry(entered, pending); assert.equal(settled, false);
      assert.deepEqual(c.trace, ['open', 'BEGIN', 'callback', 'COMMIT', 'close']); assert.deepEqual(c.closeArguments, [undefined]);
      release.resolve(); const result = await pending; assert('value' in result); assert.equal(result.value, expected);
    } finally { release.resolve(); await pending; }
  });
  await group('strict successful rollback and close preserve the original Busy by identity', async () => {
    const primary = busy(), entered = barrier(), release = barrier(), c = connection({ closeGate: { entered, release } });
    let settled = false;
    const pending = outcome(withFileCollaborationTransaction(async () => {
      c.trace.push('callback'); throw primary;
    }, c.open, { strictCleanup: true })).then(result => { settled = true; return result; });
    try {
      await awaitCloseEntry(entered, pending); assert.equal(settled, false);
      assert.deepEqual(c.trace, ['open', 'BEGIN', 'callback', 'ROLLBACK', 'close']); assert.deepEqual(c.closeArguments, [undefined]);
      release.resolve(); const result = await pending; assert('error' in result); assert.equal(result.error, primary);
    } finally { release.resolve(); await pending; }
  });
  await group('strict rollback failure discards with the exact operation/rollback aggregate and waits for close', async () => {
    const primary = busy(), rollback = new Error('controlled rollback failure'), entered = barrier(), release = barrier();
    const c = connection({ ROLLBACK: rollback, closeGate: { entered, release } }); let settled = false;
    const pending = outcome(withFileCollaborationTransaction(async () => {
      c.trace.push('callback'); throw primary;
    }, c.open, { strictCleanup: true })).then(result => { settled = true; return result; });
    try {
      await awaitCloseEntry(entered, pending); assert.equal(settled, false); assert.equal(c.closeArguments.length, 1);
      const discard = c.closeArguments[0]; terminal(discard, [primary, rollback]);
      assert.deepEqual(c.trace, ['open', 'BEGIN', 'callback', 'ROLLBACK', 'close']);
      release.resolve(); const result = await pending; assert('error' in result);
      assert.equal(result.error, discard, 'Successful discard completion must preserve the exact terminal rollback aggregate.');
    } finally { release.resolve(); await pending; }
  });
  await group('every strict close failure is terminal and preserves all real earlier causes without a second rollback or close', async () => {
    for (const mode of ['committed', 'rolled-back', 'rollback-failed'] as const) for (const synchronousClose of [false, true]) {
      const primary = busy(), rollback = new Error('controlled rollback failure'), close = new Error('controlled close failure');
      const c = connection({ ...(mode === 'rollback-failed' ? { ROLLBACK: rollback } : {}), close, synchronousClose });
      const result = await outcome(withFileCollaborationTransaction(async () => {
        c.trace.push('callback'); if (mode !== 'committed') throw primary; return 'committed callback value';
      }, c.open, { strictCleanup: true }));
      assert('error' in result);
      terminal(result.error, mode === 'committed' ? [close] : mode === 'rolled-back' ? [primary, close] : [primary, rollback, close]);
      assert.deepEqual(c.trace, ['open', 'BEGIN', 'callback', mode === 'committed' ? 'COMMIT' : 'ROLLBACK', 'close']);
      assert.equal(c.closeArguments.length, 1);
      if (mode === 'rollback-failed') terminal(c.closeArguments[0], [primary, rollback]);
      else assert.equal(c.closeArguments[0], undefined);
    }
  });
  await group('strict BEGIN and COMMIT faults retain their identity or rollback aggregate and close exactly once', async () => {
    for (const phase of ['BEGIN', 'COMMIT'] as const) for (const failRollback of [false, true]) {
      const primary = new Error(`controlled ${phase} failure`), rollback = new Error('controlled rollback failure');
      const c = connection({ [phase]: primary, ...(failRollback ? { ROLLBACK: rollback } : {}) });
      const result = await outcome(withFileCollaborationTransaction(async () => { c.trace.push('callback'); return 'must not escape'; }, c.open, { strictCleanup: true }));
      assert('error' in result);
      if (failRollback) { terminal(result.error, [primary, rollback]); assert.equal(c.closeArguments[0], result.error); }
      else { assert.equal(result.error, primary); assert.deepEqual(c.closeArguments, [undefined]); }
      assert.deepEqual(c.trace, phase === 'BEGIN' ? ['open', 'BEGIN', 'ROLLBACK', 'close'] : ['open', 'BEGIN', 'callback', 'COMMIT', 'ROLLBACK', 'close']);
      assert.equal(c.closeArguments.length, 1);
    }
  });
  await group('legacy helper options stay unchanged and only Wait availability opts into strict cleanup', async () => {
    for (const options of [undefined, {}, { strictCleanup: false }]) {
      const primary = busy(), rollback = new Error('legacy rollback failure'), close = new Error('legacy close failure');
      for (const failClose of [false, true]) {
        const c = connection({ ROLLBACK: rollback, ...(failClose ? { close } : {}) });
        const callback = async () => { c.trace.push('callback'); throw primary; };
        const result = await outcome(options === undefined ? withFileCollaborationTransaction(callback, c.open)
          : withFileCollaborationTransaction(callback, c.open, options));
        assert('error' in result); assert.equal(result.error, failClose ? close : primary);
        assert.deepEqual(c.closeArguments, [undefined]);
        assert.deepEqual(c.trace, ['open', 'BEGIN', 'callback', 'ROLLBACK', 'close']);
      }
    }
    for (const admissionLock of ['try', 'wait'] as const) {
      // Inject an operation fault at the actual acquisition call. This returns
      // no invented PG row and proves only the wrapper's cleanup-policy binding.
      const primary = new WorkspaceFileLifecycleBusyError(), rollback = new Error('availability rollback failure');
      const c = connection({ acquire: primary, ROLLBACK: rollback });
      setFileCollaborationConnectionFactoryForTests(c.open);
      try {
        const result = await outcome(assertExcalidrawLifecycleAvailable('cleanup-workspace', 'scene.excalidraw', { admissionLock }));
        assert('error' in result);
        if (admissionLock === 'wait') {
          terminal(result.error, [primary, rollback]); assert.equal(c.closeArguments[0], result.error);
          assert.deepEqual(c.trace, ['open', 'BEGIN', "SET LOCAL lock_timeout='4s'", "SET LOCAL statement_timeout='5s'", 'acquire-fault', 'ROLLBACK', 'close']);
        } else {
          assert(result.error instanceof ExcalidrawLifecycleUnavailableError); assert.equal(result.error.cause, primary);
          assert.deepEqual(c.closeArguments, [undefined]); assert.deepEqual(c.trace, ['open', 'BEGIN', 'acquire-fault', 'ROLLBACK', 'close']);
        }
        assert.equal(c.closeArguments.length, 1);
      } finally { setFileCollaborationConnectionFactoryForTests(null); }
    }
  });
  assert.equal(groups, 6);
  completed = true;
  console.log('Six mechanical cleanup fault families passed using the actual transaction helper; no PostgreSQL, HTTP authorization or pool-disposal acceptance claim.');
}

void fileCollaborationStrictCleanupTest().catch(error => { console.error(error); process.exitCode = 1; });
