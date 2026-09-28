import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  installProposalPreparingCrashProbe,
  type PreparingCrashPoint,
} from './collaboration-proposal-preparing-crash-probe';

const point: PreparingCrashPoint = 'prepared-before-apply';
const SQL = `
  UPDATE collaboration_agent_operations
  SET status = $1, updated_at = $2, cas_version = cas_version + 1
  WHERE operation_id = $3 AND cas_version = $4 AND run_generation = $5 AND status IN ($6)
`;
const operationId = 'operation-6b68d675-6f1f-4594-a62a-6542214ae877';
const params = ['applying', 1_790_000_000_000, operationId, 7, 1, 'preparing'];

function harness(verify: (input: { operationId: string; casVersion: number; runGeneration: number }) => Promise<boolean>) {
  const receiver = { marker: 'pg-client' };
  const calls: Array<{ receiver: unknown; args: unknown[] }> = [];
  const originalResult = { then: 'original-return-value' };
  const original = function (this: unknown, ...args: unknown[]): unknown {
    calls.push({ receiver: this, args });
    return originalResult;
  };
  const prototype = { query: original };
  const interrupts: string[] = [];
  const uninstall = installProposalPreparingCrashProbe({
    clientPrototype: prototype,
    verify,
    interrupt: async (target) => {
      interrupts.push(target);
      throw new Error('simulated process interruption');
    },
  });
  return { receiver, calls, originalResult, original, prototype, interrupts, uninstall };
}

function invoke(h: ReturnType<typeof harness>, ...args: unknown[]): unknown {
  return Reflect.apply(h.prototype.query, h.receiver, args);
}

test('nonmatches, callback forms and config forms pass through with receiver, args and result identity', () => {
  assert.equal(point, 'prepared-before-apply');
  const h = harness(async () => false);
  const callback = () => undefined;
  const config = { text: SQL, values: params };
  const cases: unknown[][] = [
    ['SELECT 1', []],
    [SQL, params, callback],
    [config],
  ];

  for (const args of cases) {
    const result = invoke(h, ...args);
    assert.strictEqual(result, h.originalResult);
  }
  assert.equal(h.calls.length, cases.length);
  for (const [index, call] of h.calls.entries()) {
    assert.strictEqual(call.receiver, h.receiver);
    assert.deepEqual(call.args, cases[index]);
    for (const [argumentIndex, argument] of call.args.entries()) {
      assert.strictEqual(argument, cases[index]![argumentIndex]);
    }
  }
  assert.equal(h.interrupts.length, 0);
  h.uninstall();
});

test('only the exact preparing-to-applying SQL and six validated values are verified', async () => {
  const mismatches: Array<{ sql?: string; values?: unknown[] }> = [
    { sql: SQL.replace('SET status = $1', 'SET status = $2') },
    { sql: SQL.replace('WHERE operation_id = $3', 'WHERE operation_id = $4') },
    { sql: SQL.replace('status IN ($6)', 'status IN ($7)') },
    { values: ['queued', ...params.slice(1)] },
    { values: [params[0], 0, ...params.slice(2)] },
    { values: [params[0], Number.MAX_SAFE_INTEGER + 1, ...params.slice(2)] },
    { values: [params[0], params[1], '', ...params.slice(3)] },
    { values: [params[0], params[1], 'x'.repeat(201), ...params.slice(3)] },
    { values: [params[0], params[1], 'bad operation id', ...params.slice(3)] },
    ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0'].map(cas =>
      ({ values: [params[0], params[1], params[2], cas, ...params.slice(4)] })),
    { values: [params[0], params[1], params[2], params[3], 2, params[5]] },
    { values: [params[0], params[1], params[2], params[3], params[4], 'pending'] },
    { values: [...params, 'extra'] },
  ];
  let verifications = 0;
  const h = harness(async () => { verifications++; return false; });

  for (const mismatch of mismatches) {
    const result = invoke(h, mismatch.sql ?? SQL, mismatch.values ?? params);
    assert.strictEqual(result, h.originalResult);
  }
  assert.equal(verifications, 0);
  assert.equal(h.calls.length, mismatches.length);
  assert.equal(h.interrupts.length, 0);
  h.uninstall();
});

test('a positive verification interrupts before query execution and never returns a fake result', async () => {
  const verified: unknown[] = [];
  const h = harness(async (input) => { verified.push(input); return true; });

  await assert.rejects(invoke(h, SQL, params) as Promise<unknown>, /simulated process interruption/);
  assert.deepEqual(verified, [{ operationId, casVersion: 7, runGeneration: 1 }]);
  assert.deepEqual(h.interrupts, [operationId]);
  assert.equal(h.calls.length, 0);
  h.uninstall();
});

test('the first real transition with CAS version zero is intercepted before SQL', async () => {
  const h = harness(async input => {
    assert.deepEqual(input, { operationId, casVersion: 0, runGeneration: 1 });
    return true;
  });
  const initialParams = [...params];
  initialParams[3] = 0;
  await assert.rejects(invoke(h, SQL, initialParams) as Promise<unknown>, /simulated process interruption/);
  assert.deepEqual(h.interrupts, [operationId]);
  assert.equal(h.calls.length, 0);
  h.uninstall();
});

test('a negative verification delegates the original query exactly once', async () => {
  let verified: unknown;
  const h = harness(async (input) => { verified = input; return false; });

  const result = await invoke(h, SQL, params) as unknown;
  assert.strictEqual(result, h.originalResult);
  assert.deepEqual(verified, { operationId, casVersion: 7, runGeneration: 1 });
  assert.equal(h.calls.length, 1);
  assert.strictEqual(h.calls[0]!.receiver, h.receiver);
  assert.deepEqual(h.calls[0]!.args, [SQL, params]);
  assert.equal(h.interrupts.length, 0);
  h.uninstall();
});

test('verification rejection fails closed without running SQL or interrupting', async () => {
  const h = harness(async () => { throw new Error('verification unavailable'); });

  await assert.rejects(invoke(h, SQL, params) as Promise<unknown>, /verification unavailable/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.interrupts.length, 0);
  h.uninstall();
});

test('a foreign verified-false request does not claim the target; duplicate true matches fail closed', async () => {
  const h = harness(async (input) => input.operationId === operationId);
  const foreignParams = [...params];
  foreignParams[2] = 'operation-foreign';
  const foreignRequest = invoke(h, SQL, foreignParams);
  const targetRequest = invoke(h, SQL, params);

  await assert.rejects(targetRequest as Promise<unknown>, /simulated process interruption/);
  assert.strictEqual(await foreignRequest, h.originalResult);
  assert.deepEqual(h.interrupts, [operationId]);
  assert.equal(h.calls.length, 1);
  h.uninstall();

  const duplicateHarness = harness(async () => true);
  const first = invoke(duplicateHarness, SQL, params) as Promise<unknown>;
  const second = invoke(duplicateHarness, SQL, params) as Promise<unknown>;
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 2);
  assert.equal(duplicateHarness.interrupts.length, 1, 'only one duplicate request may interrupt');
  assert.equal(duplicateHarness.calls.length, 0, 'duplicate verified target queries are never executed');
  duplicateHarness.uninstall();
});

test('uninstall restores only the wrapper it owns', () => {
  const h = harness(async () => false);
  const laterWrapper = function (): string { return 'later wrapper'; };
  h.prototype.query = laterWrapper;
  h.uninstall();
  assert.strictEqual(h.prototype.query, laterWrapper);

  const h2 = harness(async () => false);
  h2.uninstall();
  assert.strictEqual(h2.prototype.query, h2.original);
});
