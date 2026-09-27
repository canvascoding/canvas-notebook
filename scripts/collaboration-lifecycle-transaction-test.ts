import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SqlConnection } from '../app/lib/db';
import { executeLifecycleTransaction } from '../app/lib/collaboration/lifecycle-transaction';

type Faults = {
  failBegin?: Error;
  failExecute?: Error;
  failRollback?: Error;
  failCommit?: Error;
  failDiscard?: Error;
  failClose?: Error;
};

function harness(faults: Faults = {}) {
  const events: string[] = [];
  const closeErrors: Array<Error | undefined> = [];
  let connectionCloses = 0;
  const openConnection = async (): Promise<SqlConnection> => {
    events.push('open');
    return {
      get: async () => undefined,
      run: async (sql) => {
        events.push(sql);
        if (sql === 'BEGIN' && faults.failBegin) throw faults.failBegin;
        if (sql === 'ROLLBACK' && faults.failRollback) throw faults.failRollback;
        if (sql === 'COMMIT' && faults.failCommit) throw faults.failCommit;
      },
      all: async () => [],
      close: async (error) => {
        connectionCloses += 1;
        closeErrors.push(error);
        events.push(error ? 'close:discard' : 'close:release');
        if (error && faults.failDiscard) throw faults.failDiscard;
        if (!error && faults.failClose) throw faults.failClose;
      },
    };
  };
  const execute = async (database: SqlConnection) => {
    events.push('execute');
    if (faults.failExecute) throw faults.failExecute;
    await database.run('MUTATE');
    return 'committed-value';
  };
  const recoverCommitted = async (value: string, commitError: unknown) => {
    events.push('recover');
    assert.equal(value, 'committed-value');
    assert.equal(commitError, faults.failCommit);
    if (faults.failExecute) throw new Error('recovery must not follow execute failure');
    if (faults.failDiscard) throw new Error('recovery must not follow failed discard');
    return 'recovered-value';
  };
  return { events, closeErrors, openConnection, execute, recoverCommitted, get connectionCloses() { return connectionCloses; } };
}

test('acknowledged lifecycle transaction commits, closes once, and returns its value', async () => {
  const h = harness();

  const result = await executeLifecycleTransaction(h);

  assert.equal(result, 'committed-value');
  assert.deepEqual(h.events, ['open', 'BEGIN', 'execute', 'MUTATE', 'COMMIT', 'close:release']);
  assert.deepEqual(h.closeErrors, [undefined]);
  assert.equal(h.connectionCloses, 1);
});

for (const failingStage of ['BEGIN', 'execute'] as const) {
  test(`${failingStage} failure rolls back before ordinary release and does not recover`, async () => {
    const failure = new Error(`${failingStage} failed`);
    const h = harness(failingStage === 'BEGIN' ? { failBegin: failure } : { failExecute: failure });
    h.recoverCommitted = async () => {
      h.events.push('recover');
      throw new Error('unexpected recovery');
    };

    await assert.rejects(executeLifecycleTransaction(h), (error: unknown) => error === failure);

    const expected = failingStage === 'BEGIN'
      ? ['open', 'BEGIN', 'ROLLBACK', 'close:release']
      : ['open', 'BEGIN', 'execute', 'ROLLBACK', 'close:release'];
    assert.deepEqual(h.events, expected);
    assert.deepEqual(h.closeErrors, [undefined]);
    assert.equal(h.connectionCloses, 1);
  });
}

test('rollback failure discards once and aggregates operation and rollback failures', async () => {
  const operationError = new Error('execute failed');
  const rollbackError = new Error('rollback failed');
  const h = harness({ failExecute: operationError, failRollback: rollbackError });

  await assert.rejects(executeLifecycleTransaction(h), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [operationError, rollbackError]);
    assert.equal((h.closeErrors[0] as Error | undefined)?.cause, rollbackError);
    return true;
  });

  assert.deepEqual(h.events, ['open', 'BEGIN', 'execute', 'ROLLBACK', 'close:discard']);
  assert.equal(h.closeErrors.length, 1);
  assert.ok(h.closeErrors[0] instanceof Error);
  assert.equal(h.connectionCloses, 1);
});

test('uncertain COMMIT discards before recovery, never rolls back or replays execute', async () => {
  const commitError = new Error('commit reply lost');
  const h = harness({ failCommit: commitError });

  const result = await executeLifecycleTransaction(h);

  assert.equal(result, 'recovered-value');
  assert.deepEqual(h.events, ['open', 'BEGIN', 'execute', 'MUTATE', 'COMMIT', 'close:discard', 'recover']);
  assert.equal(h.closeErrors.length, 1);
  assert.ok(h.closeErrors[0] instanceof Error);
  assert.equal(h.closeErrors[0]?.cause, commitError);
  assert.equal(h.connectionCloses, 1);
  assert.equal(h.events.filter((event) => event === 'execute').length, 1);
});

test('failed discard after uncertain COMMIT aggregates errors and skips recovery', async () => {
  const commitError = new Error('commit reply lost');
  const discardError = new Error('discard failed');
  const h = harness({ failCommit: commitError, failDiscard: discardError });
  h.recoverCommitted = async () => {
    h.events.push('recover');
    throw new Error('must not recover a connection that failed to discard');
  };

  await assert.rejects(executeLifecycleTransaction(h), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [commitError, discardError]);
    return true;
  });

  assert.deepEqual(h.events, ['open', 'BEGIN', 'execute', 'MUTATE', 'COMMIT', 'close:discard']);
  assert.equal(h.connectionCloses, 1);
});

test('recovery failure propagates after one discard without another close or replay', async () => {
  const commitError = new Error('commit reply lost');
  const recoveryError = new Error('durable proof unavailable');
  const h = harness({ failCommit: commitError });
  h.recoverCommitted = async (_value, receivedCommitError) => {
    h.events.push('recover');
    assert.equal(receivedCommitError, commitError);
    throw recoveryError;
  };

  await assert.rejects(executeLifecycleTransaction(h), (error: unknown) => error === recoveryError);

  assert.deepEqual(h.events, ['open', 'BEGIN', 'execute', 'MUTATE', 'COMMIT', 'close:discard', 'recover']);
  assert.equal(h.connectionCloses, 1);
});

test('acknowledged COMMIT with failed ordinary close throws without rollback or compensation', async () => {
  const closeError = new Error('pool release failed');
  const h = harness({ failClose: closeError });
  h.recoverCommitted = async () => {
    h.events.push('recover');
    return 'must not recover an acknowledged COMMIT';
  };

  await assert.rejects(executeLifecycleTransaction(h), (error: unknown) => error === closeError);

  assert.deepEqual(h.events, ['open', 'BEGIN', 'execute', 'MUTATE', 'COMMIT', 'close:release']);
  assert.deepEqual(h.closeErrors, [undefined]);
  assert.equal(h.connectionCloses, 1);
});
