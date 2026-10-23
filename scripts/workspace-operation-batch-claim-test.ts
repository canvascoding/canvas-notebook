import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { SqlConnection } from '../app/lib/db';
import { WORKSPACE_OPERATION_REVIEW_STATEMENTS } from '../app/lib/db/workspace-operation-review-migration';
import type { WorkspaceOperationBatchExecutionResult, WorkspaceOperationBatchPlan, WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import { WorkspaceOperationBatchError, WorkspaceOperationBatchStore, assertWorkspaceOperationBatchClaimOnConnection,
  readWorkspaceOperationBatchClaimBinding, type WorkspaceOperationBatchClaim, type WorkspaceOperationBatchRecord } from '../app/lib/files/workspace-operation-batch-store';
import { createWorkspaceOperationBatchWorker } from '../app/lib/files/workspace-operation-batch-worker';
import { captureWorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-job-scope';
import { runPgliteFixture as runSqlFixture } from './helpers/pglite-pool-harness';
import { createWorkspaceOperationJobScopeFixture } from './helpers/workspace-operation-job-scope-fixture';
import { createFixtureWorkspaceOperationLegacyLinkPlan } from './helpers/workspace-operation-legacy-plan-fixture';
import { createWorkspaceOperationPhysicalDeleteBatchPlanV5, decodeWorkspaceOperationPhysicalDeleteBatchPlanV5 }
  from '../app/lib/files/workspace-operation-physical-delete-html-plan-v5';
import { workspaceOperationMixedSourceEvidenceV5Fixture } from './workspace-operation-mixed-source-evidence-v5-test';
import { createWorkspaceOperationCohortDeletePlan, decodeWorkspaceOperationCohortDeletePlan }
  from '../app/lib/files/workspace-operation-cohort-delete-plan';

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
  const physicalClaim = async () => {
    const actual = workspaceOperationMixedSourceEvidenceV5Fixture({ workspaceId: `claim-physical-${randomUUID()}`,
      native: [['note.md', "# Unicode \ud83d\ude00 \"null\" \\ \u2028 \u2029\n\n[Asset](claim.png)"]], raw: [], extra: [{ path: 'claim.png', kind: 'file' }] });
    const workspace: WorkspaceOperationBatchScope['workspace'] = { ...actual.scope,
      rootRelativePath: actual.scope.rootRelativePath ?? undefined, legacy: false, status: 'active',
      permissions: fixtureScope(actual.scope.workspaceId).workspace.permissions };
    const plan = createWorkspaceOperationPhysicalDeleteBatchPlanV5({ scope: { workspace, fileOptions: {} }, observation: actual.observation,
      actions: [{ reviewId: 'claim-physical', kind: 'delete', selections: [{ sourcePath: 'claim.png' }] }] });
    const record = await store.createDirect({ batchId: randomUUID(), plan, authorization: { mode: 'direct', actorUserId: 'claim-user',
      actorId: 'claim-user', actorType: 'user', actorDisplayName: 'Claim user', requestHash: 'b'.repeat(64),
      jobScope: captureWorkspaceOperationJobScope(workspace) } });
    const original = await store.claim(randomUUID(), 90_000); assert(original); assert.equal(original.batchId, record.batchId);
    return { original };
  };
  const cohortClaim = async () => {
    const actual = workspaceOperationMixedSourceEvidenceV5Fixture({ workspaceId: `claim-cohort-${randomUUID()}`,
      native: [['folder/note.md', "# Unicode \ud83d\ude00 \"null\" \\ \u2028 \u2029\n\n[Asset](claim.png)"]], raw: [], extra: [{ path: 'folder/claim.png', kind: 'file' }, { path: 'folder/report.pdf', kind: 'file' }] });
    const workspace: WorkspaceOperationBatchScope['workspace'] = { ...actual.scope,
      rootRelativePath: actual.scope.rootRelativePath ?? undefined, legacy: false, status: 'active',
      permissions: fixtureScope(actual.scope.workspaceId).workspace.permissions };
    const plan = createWorkspaceOperationCohortDeletePlan({ scope: { workspace, fileOptions: {} }, observation: actual.observation,
      actions: [{ reviewId: 'claim-cohort', kind: 'delete', selections: [{ sourcePath: 'folder' }] }] });
    const record = await store.createDirect({ batchId: randomUUID(), plan, authorization: { mode: 'direct', actorUserId: 'claim-user',
      actorId: 'claim-user', actorType: 'user', actorDisplayName: 'Claim user', requestHash: 'b'.repeat(64),
      jobScope: captureWorkspaceOperationJobScope(workspace) } });
    const original = await store.claim(randomUUID(), 90_000); assert(original); assert.equal(original.batchId, record.batchId);
    return { original };
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
    for (const profile of [
      { label: 'Physical5', claim: physicalClaim, decode: decodeWorkspaceOperationPhysicalDeleteBatchPlanV5 },
      { label: 'Cohort6', claim: cohortClaim, decode: decodeWorkspaceOperationCohortDeletePlan },
    ] as const) {
      await family(`genuine ${profile.label} original remains frozen with actual SQL claim provenance`, async () => {
        const { original } = await profile.claim(), plan = original.plan;
        const frozenPlan = (value: unknown): void => {
          if (value && typeof value === 'object') { assert(Object.isFrozen(value)); for (const child of Object.values(value)) frozenPlan(child); }
        };
        frozenPlan(plan);
        await store.withClaim(original, async capability => {
          const first = readWorkspaceOperationBatchClaimBinding(capability), second = readWorkspaceOperationBatchClaimBinding(capability);
          assert.equal(original.plan, plan); assert.deepEqual(first.plan, plan); assert.equal(second, first);
          assert.equal((await inspect(capability)).batchId, original.batchId); assert.equal(original.plan, plan);
        });
      });
      await family(`${profile.label} mutable original headers authorization and reviews still reject without SQL changes`, async () => {
        const mutations: Array<(row: WorkspaceOperationBatchRecord) => void> = [
          ...['batchId', 'planId', 'workspaceId', 'actionMode', 'totalActions', 'createdAt', 'leaseOwner', 'reviewerUserId', 'reviewerDisplayName']
            .map(field => (row: WorkspaceOperationBatchRecord) => {
              const value = Reflect.get(row, field); Reflect.set(row, field, typeof value === 'number' ? value + 1 : `${value}-changed`);
            }),
          row => { Reflect.set(row.authorization, 'requestHash', 'f'.repeat(64)); },
          row => { assert.equal(row.authorization.mode, 'direct'); if (row.authorization.mode === 'direct')
            Reflect.set(row.authorization, 'jobScope', { ...row.authorization.jobScope, rootPath: '/changed-root' }); },
          row => { row.reviewIds.push('changed-review'); },
          row => { row.reviewRefs.push({ reviewId: 'changed-review', planId: 'f'.repeat(64), status: 'queued' }); },
        ];
        for (const mutate of mutations) {
          const { original } = await profile.claim(), id = original.batchId, before = await raw(id);
          await assert.rejects(store.withClaim(original, async capability => {
            mutate(original); assert.throws(() => readWorkspaceOperationBatchClaimBinding(capability), code('BATCH_CLAIM_CHANGED'));
          }), code('BATCH_CLAIM_CHANGED'));
          assert.deepEqual(await raw(id), before);
        }
      });
      await family(`${profile.label} mutable toJSON keeps keys 4 9 10 and rejects after exactly one callback`, async () => {
        const { original } = await profile.claim();
        await store.withClaim(original, async capability => {
          const subjects = [original.authorization, original.reviewIds, original.reviewRefs];
          const baseline = subjects.map(value => JSON.parse(JSON.stringify(value)) as unknown), calls: string[] = [];
          try {
            for (const [index, subject] of subjects.entries()) Object.defineProperty(subject, 'toJSON', {
              configurable: true, value(key: string) { calls.push(key); return baseline[index]; },
            });
            readWorkspaceOperationBatchClaimBinding(capability);
          } finally { for (const subject of subjects) Reflect.deleteProperty(subject, 'toJSON'); }
          assert.deepEqual(calls, ['4', '9', '10']);
        });
        const changed = await profile.claim(), id = changed.original.batchId, before = await raw(id);
        const baseline = JSON.parse(JSON.stringify(changed.original.authorization)) as Record<string, unknown>;
        let calls = 0;
        await assert.rejects(store.withClaim(changed.original, async capability => {
          try {
            Object.defineProperty(changed.original.authorization, 'toJSON', { configurable: true, value(key: string) {
              assert.equal(key, '4'); return ++calls === 1 ? { ...baseline, requestHash: 'e'.repeat(64) } : baseline;
            } });
            assert.throws(() => readWorkspaceOperationBatchClaimBinding(capability), code('BATCH_CLAIM_CHANGED'));
          } finally { Reflect.deleteProperty(changed.original.authorization, 'toJSON'); }
          assert.equal(calls, 1);
        }), code('BATCH_CLAIM_CHANGED'));
        assert.equal(calls, 1); assert.deepEqual(await raw(id), before);
      });
      await family(`${profile.label} replacement mutable and foreign frozen plans remain cold and detect later changes`, async () => {
        for (const kind of ['json', 'structured', 'foreign-frozen'] as const) {
          const { original } = await profile.claim(), id = original.batchId, before = await raw(id);
          const replacement = kind === 'json' ? JSON.parse(JSON.stringify(original.plan)) as WorkspaceOperationBatchPlan
            : kind === 'structured' ? structuredClone(original.plan) : profile.decode(original.plan);
          original.plan = replacement;
          await assert.rejects(store.withClaim(original, async capability => {
            assert.deepEqual(readWorkspaceOperationBatchClaimBinding(capability).plan, replacement);
            const changed = kind === 'foreign-frozen' ? structuredClone(replacement) : replacement;
            Reflect.set(changed.pathSteps[0], 'sourcePath', 'different.png'); original.plan = changed;
            assert.throws(() => readWorkspaceOperationBatchClaimBinding(capability), code('BATCH_CLAIM_CHANGED'));
          }), code('BATCH_CLAIM_CHANGED'));
          assert.deepEqual(await raw(id), before);
        }
      });
      await family(`${profile.label} inherited Object and Array toJSON stay cold with genuine plan callbacks`, async () => {
        for (const prototype of [Object.prototype, Array.prototype]) for (const changed of [false, true]) {
          const { original } = await profile.claim(), plan = original.plan, prior = Object.getOwnPropertyDescriptor(prototype, 'toJSON');
          const calls: string[] = [];
          const operation = store.withClaim(original, async capability => {
            try {
              Object.defineProperty(prototype, 'toJSON', { configurable: true, value(this: object, key: string) {
                if (this === (prototype === Object.prototype ? plan : plan.pathSteps)) {
                  calls.push(key);
                  if (changed) return prototype === Object.prototype ? { ...plan, planId: 'e'.repeat(64) }
                    : [{ ...plan.pathSteps[0], sourcePath: 'different.png' }];
                }
                return this;
              } });
              if (changed) assert.throws(() => readWorkspaceOperationBatchClaimBinding(capability), code('BATCH_CLAIM_CHANGED'));
              else readWorkspaceOperationBatchClaimBinding(capability);
            } finally { if (prior) Object.defineProperty(prototype, 'toJSON', prior); else Reflect.deleteProperty(prototype, 'toJSON'); }
            assert.deepEqual(calls, [prototype === Object.prototype ? '3' : 'pathSteps']);
          });
          if (changed) await assert.rejects(operation, code('BATCH_CLAIM_CHANGED')); else await operation;
        }
      });
      await family(`${profile.label} held JSON lookup precedes headers and unusual descriptors use the cold original`, async () => {
        const fields = ['batchId', 'planId', 'workspaceId', 'plan', 'authorization', 'actionMode', 'totalActions', 'createdAt',
          'leaseOwner', 'reviewIds', 'reviewRefs', 'reviewerUserId', 'reviewerDisplayName'] as const;
        for (const changed of [false, true]) {
          const { original } = await profile.claim();
          const operation = store.withClaim(original, async capability => {
            const descriptors = Object.getOwnPropertyDescriptors(original), values = fields.map(field => original[field]);
            const prior = Object.getOwnPropertyDescriptor(JSON, 'stringify')!, held = JSON.stringify, events: string[] = [];
            try {
              Object.defineProperty(JSON, 'stringify', { configurable: true, get() { events.push('lookup'); return held; } });
              for (const [index, field] of fields.entries()) Object.defineProperty(original, field, { configurable: true, enumerable: true,
                get() { events.push(field); if (field === 'reviewerDisplayName') Object.defineProperty(JSON, 'stringify', {
                  ...prior, value() { throw new Error('A second JSON function lookup is forbidden.'); },
                }); return changed && field === 'totalActions' ? Number(values[index]) + 1 : values[index]; },
              });
              if (changed) assert.throws(() => readWorkspaceOperationBatchClaimBinding(capability), code('BATCH_CLAIM_CHANGED'));
              else readWorkspaceOperationBatchClaimBinding(capability);
            } finally {
              Object.defineProperty(JSON, 'stringify', prior);
              for (const field of fields) Object.defineProperty(original, field, descriptors[field]);
            }
            assert.deepEqual(events, ['lookup', ...fields]);
          });
          if (changed) await assert.rejects(operation, code('BATCH_CLAIM_CHANGED')); else await operation;
        }
        const { original } = await profile.claim();
        await store.withClaim(original, async capability => {
          const prior = Object.getOwnPropertyDescriptor(globalThis, 'JSON')!, held = JSON, native = JSON.stringify;
          let lookups = 0, descriptorTraps = 0;
          try {
            Object.defineProperty(globalThis, 'JSON', { ...prior, value: new Proxy(held, {
              get(target, key, receiver) { if (key === 'stringify') { lookups++; return native; } return Reflect.get(target, key, receiver); },
              getOwnPropertyDescriptor() { descriptorTraps++; throw new Error('A foreign JSON descriptor must not be inspected.'); },
            }) });
            readWorkspaceOperationBatchClaimBinding(capability);
          } finally { Object.defineProperty(globalThis, 'JSON', prior); }
          assert.equal(lookups, 1); assert.equal(descriptorTraps, 0);
        });
      });
    }
    console.log(`claim fixture: ${families} genuine SQL families passed; no principal or lifecycle-owner authority claimed`);
  } finally {
    try { await database.close(); } finally { assert.equal(await sourceHash(), pinned); }
  }
}

void runSqlFixture({ label: 'workspace-operation-batch-claim-test', operation: main,
  successMessage: 'workspace-operation-batch-claim-test: all genuine SQL claim families passed' });
