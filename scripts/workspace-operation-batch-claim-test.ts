import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { SqlConnection } from '../app/lib/db';
import { WORKSPACE_OPERATION_REVIEW_STATEMENTS } from '../app/lib/db/workspace-operation-review-migration';
import type { WorkspaceOperationBatchExecutionResult, WorkspaceOperationBatchPlan, WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import { WorkspaceOperationBatchError, WorkspaceOperationBatchStore, assertWorkspaceOperationBatchClaimOnConnection,
  type WorkspaceOperationBatchClaim, type WorkspaceOperationBatchRecord } from '../app/lib/files/workspace-operation-batch-store';
import { createWorkspaceOperationBatchWorker } from '../app/lib/files/workspace-operation-batch-worker';
import { captureWorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-job-scope';
import { runPgliteFixture as runSqlFixture } from './helpers/pglite-pool-harness';
import { createWorkspaceOperationJobScopeFixture } from './helpers/workspace-operation-job-scope-fixture';
import { createFixtureWorkspaceOperationLegacyLinkPlan } from './helpers/workspace-operation-legacy-plan-fixture';

// Actual SQL proves claim provenance here. Injected scope/execute/kernel in the
// worker cases do not prove current principal rights, FS effects or Owner-B.
const source = 'scripts/workspace-operation-batch-claim-test.ts';
const sourceHash = async () => createHash('sha256').update(await readFile(source)).digest('hex');
const code = (expected: string) => (error: unknown) => error instanceof WorkspaceOperationBatchError
  && error.code === expected && error.status === (expected === 'BATCH_CLAIM_COMMIT_UNCONFIRMED' ? 503 : 409);
const done: WorkspaceOperationBatchExecutionResult = { status: 'applied', completedActions: 1, totalActions: 1,
  trashEntryIds: [], errorCode: null };

function fixtureScope(workspaceId: string): WorkspaceOperationBatchScope {
  return { workspace: { workspaceId, workspaceType: 'personal', rootPath: `/claim-fixture/${workspaceId}`,
    status: 'active', ownerUserId: 'claim-user', legacy: false, permissions: { canRead: true, canWrite: true,
      canDelete: true, canCreatePublicLinks: false, canManageWorkspace: true, canRunAgent: true } }, fileOptions: {} };
}

function fixturePlan(workspaceId: string): WorkspaceOperationBatchPlan {
  return { version: 1, workspaceId, planId: 'a'.repeat(64), readiness: 'ready',
    actions: [{ reviewId: 'claim-action', kind: 'delete', selections: [{ sourcePath: ' original.md' }] }],
    pathSteps: [{ reviewId: 'claim-action', kind: 'delete', sourcePath: ' original.md' }], pathMappings: [],
    deletedPaths: [], linkEdits: [], originalDocuments: [], previewContents: [], expectedPathState: [],
    coverage: { complete: true, omittedSources: [], unresolvedLinks: [] },
    linkAssessment: { version: 1, complete: true, blockers: [], warnings: [] }, issues: [],
    linkPlan: createFixtureWorkspaceOperationLegacyLinkPlan(workspaceId, [{ reviewId: 'claim-action', kind: 'delete', selections: [{ sourcePath: ' original.md' }] }]) };
}

async function main(): Promise<void> {
  const pinned = await sourceHash();
  console.log('Claim fixture frozen source:', pinned);
  const database = await createWorkspaceOperationJobScopeFixture();
  let families = 0;
  const connect = () => database.connect();
  const store = new WorkspaceOperationBatchStore(connect);
  const raw = async (batchId: string) => (await database.query<Record<string, unknown>>(
    'SELECT * FROM workspace_file_operation_batches WHERE batch_id=$1', [batchId])).rows[0]!;
  const create = async () => {
    const workspaceId = `claim-workspace-${randomUUID()}`, scope = fixtureScope(workspaceId), plan = fixturePlan(workspaceId);
    const record = await store.createDirect({ batchId: randomUUID(), plan, authorization: { mode: 'direct', actorUserId: 'claim-user',
      actorId: 'claim-user', actorType: 'user', actorDisplayName: 'Claim user', requestHash: 'b'.repeat(64),
      jobScope: captureWorkspaceOperationJobScope(scope.workspace) } });
    return { record, scope, plan };
  };
  const claim = async (owner = randomUUID(), leaseMs = 90_000) => {
    const fixture = await create();
    const original = await store.claim(owner, leaseMs); assert(original); assert.equal(original.batchId, fixture.record.batchId);
    return { ...fixture, original, owner };
  };
  const borrowed = async <T>(operation: (connection: SqlConnection) => Promise<T>) => {
    const connection = await connect(); let begun = false;
    try {
      await connection.run('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); begun = true;
      return await operation(connection);
    } finally {
      try { if (begun) await connection.run('ROLLBACK'); } finally { await connection.close(); }
    }
  };
  const inspect = (capability: WorkspaceOperationBatchClaim) => borrowed(connection =>
    assertWorkspaceOperationBatchClaimOnConnection(connection, capability));
  const family = async (label: string, operation: () => Promise<void>) => {
    await database.exec('TRUNCATE workspace_file_operation_reviews,workspace_file_operation_batches');
    await operation(); families += 1; console.log(`claim fixture: ${label} passed`);
  };
  try {
    for (const statement of WORKSPACE_OPERATION_REVIEW_STATEMENTS) await database.exec(statement);
    await family('actual original claim and frozen SQL realm binding', async () => {
      const { original, plan } = await claim();
      const persisted = await raw(original.batchId);
      assert.equal(typeof persisted.lease_token, 'string'); assert.match(String(persisted.lease_token), /^[a-zA-Z0-9_-]{16,128}$/u);
      await store.withClaim(original, async capability => {
        const binding = await inspect(capability);
        assert.equal(binding.batchId, original.batchId); assert.equal(binding.planId, original.planId);
        assert.equal(binding.workspaceId, original.workspaceId); assert.deepEqual(binding.plan, plan);
        assert.deepEqual(binding.authorization, original.authorization); assert.equal(binding.actionMode, 'apply');
        for (const value of [binding, binding.plan, binding.plan.actions, binding.authorization, binding.source]) assert(Object.isFrozen(value));
        assert.equal(Reflect.set(binding, 'workspaceId', 'changed'), false);
        const actual = (await database.query<{ table_oid: number; schema_oid: number; database_oid: number; schema_name: string }>(
          `SELECT c.oid::bigint AS table_oid,n.oid::bigint AS schema_oid,n.nspname AS schema_name,
            (SELECT oid::bigint FROM pg_database WHERE datname=current_database()) AS database_oid
           FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='workspace_file_operation_batches'::regclass`)).rows[0]!;
        assert.equal(binding.source.tableOid, Number(actual.table_oid)); assert.equal(binding.source.schemaOid, Number(actual.schema_oid));
        assert.equal(binding.source.databaseOid, Number(actual.database_oid)); assert.equal(binding.source.schemaName, actual.schema_name);
        assert(!('leaseToken' in binding)); assert(!('leaseOwner' in binding));
      });
    });
    await family('get copies JSON other stores and forged store cannot mint', async () => {
      const { original } = await claim(), read = await store.get(original.batchId); assert(read);
      for (const copy of [read, { ...original }, JSON.parse(JSON.stringify(original)) as WorkspaceOperationBatchRecord]) {
        await assert.rejects(store.withClaim(copy, async () => { assert.fail('copied record reached consumer'); }), code('BATCH_CLAIM_REQUIRED'));
      }
      const other = new WorkspaceOperationBatchStore(connect);
      await assert.rejects(other.withClaim(original, async () => { assert.fail('other store reached consumer'); }), code('BATCH_CLAIM_REQUIRED'));
      await assert.rejects(WorkspaceOperationBatchStore.prototype.withClaim.call({} as WorkspaceOperationBatchStore,
        original, async () => { assert.fail('forged store reached consumer'); }), code('BATCH_CLAIM_REQUIRED'));
    });
    await family('retained capabilities and callbacks expire after return', async () => {
      const { original } = await claim(); let retained: WorkspaceOperationBatchClaim | undefined;
      await store.withClaim(original, async capability => { retained = capability; await inspect(capability); });
      assert(retained); await assert.rejects(inspect(retained), code('BATCH_CLAIM_REQUIRED'));
      await assert.rejects(store.heartbeatClaim(original), code('BATCH_CLAIM_REQUIRED'));
      await assert.rejects(store.withClaim(original, async () => { assert.fail('closed claim reentered'); }), code('BATCH_CLAIM_REQUIRED'));
    });
    await family('caught retained claim A poisons active claim B before success finalization', async () => {
      const first = await claim(); let retained: WorkspaceOperationBatchClaim | undefined;
      await store.withClaim(first.original, async capability => { retained = capability; await inspect(capability); });
      assert(retained);
      const second = await claim();
      const poisoned = (error: unknown) => code('BATCH_CLAIM_REQUIRED')(error) || code('BATCH_CLAIM_FAILED')(error);
      await assert.rejects(store.withClaim(second.original, async current => {
        const binding = await inspect(current); assert.equal(binding.batchId, second.original.batchId);
        await assert.rejects(inspect(retained!), code('BATCH_CLAIM_REQUIRED'));
        await assert.rejects(store.finishClaim(second.original, { status: 'applied', completedActions: 1 }), poisoned);
      }), poisoned);
      assert.notEqual((await raw(second.original.batchId)).status, 'applied');
    });
    await family('mutable original record cannot change private provenance', async () => {
      const { original } = await claim();
      original.plan = { ...original.plan, pathSteps: [{ ...original.plan.pathSteps[0], sourcePath: 'different.md' }] };
      await assert.rejects(store.withClaim(original, async () => { assert.fail('mutated original reached consumer'); }), code('BATCH_CLAIM_CHANGED'));
    });
    await family('constructor runtime cannot be replaced through mutable TS properties', async () => {
      const fixture = await create(), originalRuntime = new WorkspaceOperationBatchStore(connect);
      Reflect.set(originalRuntime, 'connect', async () => { assert.fail('mutable connection property was trusted'); });
      Reflect.set(originalRuntime, 'now', () => 0);
      const original = await originalRuntime.claim(randomUUID()); assert(original); assert.equal(original.batchId, fixture.record.batchId);
      assert(Number((await raw(original.batchId)).lease_expires_at) > Date.now());
      await originalRuntime.withClaim(original, async capability => { await inspect(capability); });
    });
    await family('caught SQL plan mismatch poisons the whole turn', async () => {
      const { original } = await claim();
      await assert.rejects(store.withClaim(original, async capability => {
        const changed = { ...original.plan, pathSteps: [{ ...original.plan.pathSteps[0], sourcePath: 'different.md' }] };
        await database.query('UPDATE workspace_file_operation_batches SET plan_json=$2 WHERE batch_id=$1', [original.batchId, JSON.stringify(changed)]);
        await assert.rejects(inspect(capability), code('BATCH_CLAIM_CHANGED'));
      }), code('BATCH_CLAIM_CHANGED'));
    });
    await family('caught nested claim failure poisons the outer callback', async () => {
      const { original } = await claim();
      await assert.rejects(store.withClaim(original, async () => {
        await assert.rejects(store.withClaim(original, async () => { assert.fail('nested consumer entered'); }), code('BATCH_CLAIM_REENTRANT'));
      }), code('BATCH_CLAIM_REENTRANT'));
    });
    await family('detached borrowed assertion is drained and rejected', async () => {
      const { original } = await claim(); let pending: Promise<unknown> | undefined;
      await borrowed(async connection => {
        await assert.rejects(store.withClaim(original, async capability => {
          pending = assertWorkspaceOperationBatchClaimOnConnection(connection, capability);
          void pending.catch(() => undefined);
        }), code('BATCH_CLAIM_DETACHED'));
        assert(pending); await Promise.allSettled([pending]);
      });
    });
    const changes: Array<[string, string, (row: WorkspaceOperationBatchRecord) => unknown]> = [
      ['owner', 'lease_owner', () => 'another-owner'], ['token', 'lease_token', () => randomUUID()],
      ['status', 'status', () => 'queued'], ['action mode', 'action_mode', () => 'undo'],
      ['plan identity', 'plan_id', () => 'c'.repeat(64)], ['workspace', 'workspace_id', () => 'different-workspace'],
      ['reviewer identity', 'reviewer_user_id', () => 'different-reviewer'], ['reviewer name', 'reviewer_display_name', () => 'Different reviewer'],
      ['authorization', 'authorization_json', row => JSON.stringify({ ...row.authorization, requestHash: 'd'.repeat(64) })],
      ['stored scope', 'authorization_json', row => JSON.stringify({ ...row.authorization,
        jobScope: { ...(row.authorization.mode === 'direct' ? row.authorization.jobScope : {}), rootPath: '/different-root' } })],
    ];
    for (const [label, column, value] of changes) await family(`actual SQL ${label} drift rejects`, async () => {
      const { original } = await claim();
      await assert.rejects(store.withClaim(original, async capability => {
        await database.query(`UPDATE workspace_file_operation_batches SET ${column}=$2 WHERE batch_id=$1`, [original.batchId, value(original)]);
        await inspect(capability);
      }), code('BATCH_CLAIM_CHANGED'));
    });
    await family('borrowed autocommit is not a held transaction', async () => {
      const { original } = await claim();
      await assert.rejects(store.withClaim(original, async capability => {
        const connection = await connect();
        try { await assertWorkspaceOperationBatchClaimOnConnection(connection, capability); } finally { await connection.close(); }
      }), code('BATCH_CLAIM_CHANGED'));
    });
    await family('borrowed search path cannot change the captured realm', async () => {
      const { original } = await claim();
      await assert.rejects(store.withClaim(original, async capability => borrowed(async connection => {
        await connection.run('SET LOCAL search_path=pg_catalog');
        await assertWorkspaceOperationBatchClaimOnConnection(connection, capability);
      })), code('BATCH_CLAIM_CHANGED'));
    });
    await family('actual heartbeat retains token and updates progress', async () => {
      const { original } = await claim(randomUUID(), 30_000), before = await raw(original.batchId);
      await store.withClaim(original, async capability => {
        assert.equal(await store.heartbeatClaim(original, { completedActions: 0, totalActions: 1, phase: 'paths' }), true);
        const after = await raw(original.batchId);
        assert.equal(after.lease_token, before.lease_token); assert(Number(after.lease_expires_at) > Number(before.lease_expires_at));
        assert.equal(after.phase, 'paths'); await inspect(capability);
      });
    });
    for (const operation of ['heartbeat', 'finish'] as const) await family(`expired ${operation} cannot revive the lease`, async () => {
      const { original } = await claim(randomUUID(), 500);
      await assert.rejects(store.withClaim(original, async () => {
        const before = await raw(original.batchId);
        await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(before.lease_expires_at) - Date.now()) + 20));
        await assert.rejects(operation === 'heartbeat' ? store.heartbeatClaim(original)
          : store.finishClaim(original, { status: 'applied', completedActions: 1 }), code('BATCH_CLAIM_EXPIRED'));
        assert.deepEqual(await raw(original.batchId), before);
      }), code('BATCH_CLAIM_EXPIRED'));
    });
    await family('same owner reclaim creates a new incarnation', async () => {
      const { original, owner } = await claim(), before = await raw(original.batchId);
      const replacementStore = new WorkspaceOperationBatchStore(connect); let replacement: WorkspaceOperationBatchRecord | null = null;
      await assert.rejects(store.withClaim(original, async capability => {
        await database.query('UPDATE workspace_file_operation_batches SET lease_expires_at=0 WHERE batch_id=$1', [original.batchId]);
        replacement = await replacementStore.claim(owner); assert(replacement); assert.equal(replacement.batchId, original.batchId);
        const after = await raw(original.batchId); assert.equal(after.lease_owner, before.lease_owner); assert.notEqual(after.lease_token, before.lease_token);
        await assert.rejects(inspect(capability), code('BATCH_CLAIM_CHANGED'));
        await assert.rejects(store.heartbeatClaim(original), code('BATCH_CLAIM_CHANGED'));
        await assert.rejects(store.finishClaim(original, { status: 'applied', completedActions: 1 }), code('BATCH_CLAIM_CHANGED'));
        assert.deepEqual(await raw(original.batchId), after);
      }), code('BATCH_CLAIM_CHANGED'));
      assert(replacement); await replacementStore.withClaim(replacement, async capability => { await inspect(capability); });
    });
    await family('finish inside a genuine turn clears the lease once', async () => {
      const { original } = await claim();
      await store.withClaim(original, async () => {
        const finished = await store.finishClaim(original, { status: 'applied', completedActions: 1, phase: 'complete' });
        assert(finished); assert.equal(finished.status, 'applied'); assert.equal(finished.leaseOwner, null);
      });
      const after = await raw(original.batchId); assert.equal(after.status, 'applied'); assert.equal(after.lease_owner, null); assert.equal(after.lease_token, null);
      await assert.rejects(store.finishClaim(original, { status: 'applied', completedActions: 1 }), code('BATCH_CLAIM_REQUIRED'));
      assert.deepEqual(await raw(original.batchId), after);
    });
    await family('closed failed callback can only finalize its original live failure', async () => {
      const { original } = await claim(), failure = new Error('Expected claim fixture callback failure.');
      await assert.rejects(store.withClaim(original, async () => { throw failure; }), error => error === failure);
      const before = await raw(original.batchId);
      await assert.rejects(store.finishClaim(original, { status: 'applied', completedActions: 1 }), code('BATCH_CLAIM_REQUIRED'));
      assert.deepEqual(await raw(original.batchId), before);
      const finalized = await store.finishClaim(original, { status: 'failed', errorCode: 'FIXTURE_EXPECTED_FAILURE', phase: 'preparing' });
      assert(finalized); assert.equal(finalized.status, 'failed'); assert.equal(finalized.errorCode, 'FIXTURE_EXPECTED_FAILURE');
      assert.equal(finalized.leaseOwner, null); assert.equal((await raw(original.batchId)).lease_token, null);
    });
    for (const [label, thrown] of [['undefined', undefined], ['null', null], ['false', false]] as const) await family(`throw ${label} rejects retires the capability and cannot finish success`, async () => {
      const { original } = await claim(); let retained: WorkspaceOperationBatchClaim | undefined, reachedThrow = false;
      await assert.rejects(store.withClaim(original, async capability => {
        retained = capability; await inspect(capability); reachedThrow = true; throw thrown;
      }), code('BATCH_CLAIM_FAILED'));
      assert.equal(reachedThrow, true); assert(retained);
      await assert.rejects(inspect(retained), code('BATCH_CLAIM_REQUIRED'));
      const before = await raw(original.batchId);
      await assert.rejects(store.finishClaim(original, { status: 'applied', completedActions: 1 }), code('BATCH_CLAIM_REQUIRED'));
      assert.deepEqual(await raw(original.batchId), before); assert.equal(before.status, 'applying');
    });
    await family('actual worker forwards a live claim and closes it after tick', async () => {
      const fixture = await create(); let forwarded: WorkspaceOperationBatchClaim | undefined, executions = 0;
      const worker = createWorkspaceOperationBatchWorker({ store, resolveScope: async () => fixture.scope,
        lock: async (_workspaceId, operation) => operation(), buildPlan: async () => fixture.plan,
        hasExecution: async () => false, dependentReviews: async () => undefined, projectFileViews: () => undefined,
        execute: async input => {
          assert(input.jobClaim, 'the actual worker must forward its genuine claim'); forwarded = input.jobClaim;
          const binding = await inspect(input.jobClaim); assert.equal(binding.batchId, fixture.record.batchId);
          await input.onProgress?.({ completedActions: 0, totalActions: 1, phase: 'paths' }); executions += 1; return done;
        } });
      assert.equal(await worker.tick(), true); assert.equal(executions, 1); assert(forwarded);
      assert.equal((await store.get(fixture.record.batchId))?.status, 'applied');
      await assert.rejects(inspect(forwarded), code('BATCH_CLAIM_REQUIRED'));
    });
    for (const field of ['plan_json', 'authorization_json', 'lease_token'] as const) await family(`worker ${field} drift blocks the next mutation`, async () => {
      const fixture = await create(); let afterGateMutations = 0;
      const worker = createWorkspaceOperationBatchWorker({ store, resolveScope: async () => fixture.scope,
        lock: async (_workspaceId, operation) => operation(), buildPlan: async () => fixture.plan,
        hasExecution: async () => false, dependentReviews: async () => undefined, projectFileViews: () => undefined,
        execute: async input => {
          assert(input.jobClaim); await inspect(input.jobClaim);
          const value = field === 'plan_json' ? JSON.stringify({ ...fixture.plan, planId: 'e'.repeat(64) })
            : field === 'authorization_json' ? JSON.stringify({ ...fixture.record.authorization, requestHash: 'f'.repeat(64) }) : randomUUID();
          await database.query(`UPDATE workspace_file_operation_batches SET ${field}=$2 WHERE batch_id=$1`, [fixture.record.batchId, value]);
          await input.onProgress?.({ completedActions: 0, totalActions: 1, phase: 'paths' });
          afterGateMutations += 1; return done;
        } });
      await assert.rejects(worker.tick(), code('BATCH_CLAIM_CHANGED')); assert.equal(afterGateMutations, 0);
      assert.notEqual((await store.get(fixture.record.batchId))?.status, 'applied');
    });
    console.log(`claim fixture: ${families} genuine SQL families passed; no principal or lifecycle-owner authority claimed`);
  } finally {
    try { await database.close(); } finally { assert.equal(await sourceHash(), pinned); }
  }
}

void runSqlFixture({ label: 'workspace-operation-batch-claim-test', operation: main,
  successMessage: 'workspace-operation-batch-claim-test: all genuine SQL claim families passed' });
