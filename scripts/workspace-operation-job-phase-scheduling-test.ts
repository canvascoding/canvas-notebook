import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { executeLifecycleTransaction } from '../app/lib/collaboration/lifecycle-transaction';
import { createFixtureWorkspaceOperationLegacyLinkPlan } from './helpers/workspace-operation-legacy-plan-fixture';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { SqlConnection } from '../app/lib/db';
import { WORKSPACE_OPERATION_REVIEW_STATEMENTS } from '../app/lib/db/workspace-operation-review-migration';
import { WorkspaceOperationBatchStore, WorkspaceOperationBatchError, readWorkspaceOperationBatchClaimBinding, type WorkspaceOperationBatchClaim } from '../app/lib/files/workspace-operation-batch-store';
import { createWorkspaceOperationBatchWorker } from '../app/lib/files/workspace-operation-batch-worker';
import { withWorkspaceOperationJobClaimPhase as phase, withWorkspaceOperationJobClaimScheduling as scheduling,
  WorkspaceOperationJobPhaseSchedulingError } from '../app/lib/files/workspace-operation-job-phase-scheduling';
import { captureWorkspaceOperationJobScope } from '../app/lib/files/workspace-operation-job-scope';
import type { WorkspaceOperationBatchPlan, WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import { runPgliteFixture } from './helpers/pglite-pool-harness';

// Real embedded SQL mints the original Store claims. Controlled interval calls
// prove scheduling, not independent PostgreSQL backends, Owner-B or file writes.
const sources = ['app/lib/files/workspace-operation-job-phase-scheduling.ts',
  'app/lib/files/workspace-operation-batch-worker.ts', 'scripts/workspace-operation-job-phase-scheduling-test.ts',
  'app/lib/files/workspace-operation-job-lifecycle-owner.ts', 'app/lib/files/workspace-operation-native-path-admission.ts',
  'app/lib/files/workspace-operation-original-move-runner.ts', 'app/lib/collaboration/lifecycle-transaction.ts'];
const hashes = () => Promise.all(sources.map(async file => createHash('sha256').update(await readFile(file)).digest('hex')));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const includesError = (error: unknown, expected: unknown): boolean => error === expected
  || error instanceof AggregateError && error.errors.some(child => includesError(child, expected));
const code = (expected: string) => (error: unknown): boolean => error instanceof Error
  && (Object.getOwnPropertyDescriptor(error, 'code')?.value === expected
    || error instanceof AggregateError && error.errors.some(child => code(expected)(child)));
const noScheduling = { pauseAndDrain: async () => undefined, resume: async () => undefined };
const result = { status: 'applied' as const, completedActions: 1, totalActions: 1, trashEntryIds: [], errorCode: null };

function manualWorkerIntervals() {
  const setDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'setInterval')!;
  const clearDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'clearInterval')!;
  const originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval;
  const intervals = new Map<ReturnType<typeof setInterval>, () => void>();
  let onClear: (() => void) | undefined;
  const set = ((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay !== 20_000) return Reflect.apply(originalSet, globalThis, [callback, delay, ...args]);
    const token = { unref: () => token } as ReturnType<typeof setInterval>;
    intervals.set(token, callback); return token;
  }) as typeof setInterval;
  const clear = ((token: ReturnType<typeof setInterval>) => {
    if (!intervals.delete(token)) return originalClear(token);
    onClear?.();
  }) as typeof clearInterval;
  Object.defineProperty(globalThis, 'setInterval', { ...setDescriptor, value: set });
  Object.defineProperty(globalThis, 'clearInterval', { ...clearDescriptor, value: clear });
  let restored = false;
  return {
    get size() { return intervals.size; },
    first() { assert.equal(intervals.size, 1); return [...intervals.values()][0]; },
    observeClear(operation: () => void) { onClear = operation; },
    restore() {
      if (restored) return; restored = true;
      Object.defineProperty(globalThis, 'setInterval', setDescriptor);
      Object.defineProperty(globalThis, 'clearInterval', clearDescriptor);
      assert.equal(intervals.size, 0, 'every owned worker interval must have been cleared');
    },
  };
}

type PreownerOptions = { stage: 'history' | 'admission'; fault?: 'lookalike' | 'auth' | 'sql' | 'aggregate';
  rollbackFails?: boolean; closeFails?: boolean; commitFails?: boolean; resumeFails?: boolean; claimFails?: boolean; claimChanges?: boolean;
  authAfterBusy?: boolean; forever?: boolean; cost?: number; ownerFails?: boolean; nonhuman?: boolean };
/** Saved public History/Wait/Runner, real lifecycle unwind and real Claim
 * scheduler with a genuine embedded-Store claim. SQL/Principal/room/Owner
 * replies below are declared seams, not PG contention or FS acceptance. */
async function preownerFixture(claim: WorkspaceOperationBatchClaim, options: PreownerOptions) {
  class PrincipalError extends Error { constructor(readonly code: string) { super(code); } }
  class BusyError extends Error { readonly code = 'COLLABORATION_FILE_LIFECYCLE_BUSY'; }
  class AdmissionError extends Error { constructor(readonly code: string) { super(code); } }
  const original = readWorkspaceOperationBatchClaimBinding(claim), scope = original.authorization.mode === 'direct' ? original.authorization.jobScope! : assert.fail();
  const plan = { version: 3, workspaceId: original.workspaceId, planId: original.planId, readiness: 'ready',
    sourceEvidence: { workspaceScope: scope, nativeBindings: [] } };
  const binding = { ...original, plan, authorization: { ...original.authorization, actorType: options.nonhuman ? 'agent' : 'user' } };
  const request = { requestId: 'ad1d00cb-008f-43e7-aee9-c9e799b93cf8' };
  const state = { now: 0, opened: 0, live: 0, schema: 0, phase: 0, mutationScope: 0, policies: 0, resumes: 0,
    rollbacks: 0, ownerCalls: 0, history: 0, admission: 0, drift: false, sleeps: [] as number[], events: [] as string[] };
  const primary = options.fault === 'lookalike' ? Object.assign(new Error('Declared lookalike.'), { code: 'PRINCIPAL_BUSY' })
    : options.fault === 'auth' ? new PrincipalError('PRINCIPAL_AUTH_REVOKED')
    : options.fault === 'sql' ? Object.assign(new Error('Declared SQL unknown.'), { code: '08006' })
    : options.fault === 'aggregate' ? new AggregateError([new PrincipalError('PRINCIPAL_BUSY')]) : new PrincipalError('PRINCIPAL_BUSY');
  const clean = () => { assert.equal(state.live, 0); assert.equal(state.phase, 0); assert.equal(state.schema, 0); assert.equal(state.mutationScope, 0); };
  const databaseStages = new WeakMap<SqlConnection, 'history' | 'admission'>();
  let activeStage: 'history' | 'admission' | undefined;
  const open = async (): Promise<SqlConnection> => {
    assert.equal(state.live, 0); state.opened++; state.live++; let begun = false, closed = false;
    const database: SqlConnection = {
      run: async sql => {
        assert.equal(closed, false); state.events.push(sql.split(' ')[0]);
        if (sql.startsWith('BEGIN')) { begun = true; activeStage = sql.includes('ISOLATION') ? 'history' : 'admission'; databaseStages.set(database, activeStage); }
        if (sql === 'ROLLBACK') { if (options.rollbackFails) throw new Error('Declared rollback failure.'); state.rollbacks++; begun = false; }
        if (sql === 'COMMIT') { if (options.commitFails && databaseStages.get(database) === options.stage) throw new PrincipalError('PRINCIPAL_BUSY'); begun = false; }
      },
      get: async sql => {
        assert.equal(closed, false);
        if (sql.includes('pg_backend_pid() AS backend')) return { backend: 11, start: '100.1', database: original.source.databaseOid,
          schema: original.source.schemaOid, search_path: original.source.searchPath, isolation: 'read committed', read_only: 'off',
          replication: 'origin', transaction: begun ? '10' : sql.includes('pg_current_xact_id()') ? '9' : null };
        if (sql.includes('current_schema()')) return { schema_name: original.source.schemaName, schema_oid: original.source.schemaOid,
          database_oid: original.source.databaseOid, search_path: original.source.searchPath };
        if (sql.includes('collaboration_admission_requests')) return undefined;
        assert.fail('Unexpected pre-owner SQL get.');
      },
      all: async (sql, values = []) => {
        assert.equal(closed, false);
        if (sql.includes('pg_catalog.unnest')) return (values[1] as string[]).map((name, index) => ({ name, oid: index + 100,
          schema_oid: original.source.schemaOid, resolved: index + 100, relkind: 'r', relpersistence: 'p', relrowsecurity: false, relforcerowsecurity: false }));
        if (sql.includes('SELECT DISTINCT CASE')) return [];
        assert.fail('Unexpected pre-owner SQL all.');
      },
      close: async () => { assert.equal(closed, false); closed = true; state.live--; activeStage = undefined; state.events.push('close');
        if (options.closeFails && databaseStages.get(database) === options.stage) throw new PrincipalError('PRINCIPAL_BUSY'); },
    }; return database;
  };
  const authorize = async (_database: SqlConnection, _input: unknown, operation: (access: unknown) => Promise<unknown>) => {
    // Admission forwards the actual connection through a new method wrapper.
    // Observe its real BEGIN on the single live fixture connection instead.
    assert.equal(state.live, 1); const stage = activeStage; assert(stage !== undefined);
    state[stage]++; state.now += options.cost ?? 0;
    if (options.authAfterBusy && state[stage] === 2) throw new PrincipalError('PRINCIPAL_AUTH_REVOKED');
    if (!options.commitFails && stage === options.stage && (state[stage] === 1 || options.forever)) throw primary;
    return operation({ workspace: scope, assertCurrent: async () => undefined });
  };
  const storage = { assertCurrent: async () => undefined };
  const mocks: Record<string, unknown> = {
    'server-only': {}, '../db': { openDb: open }, '../workspaces/request-principal': { WorkspaceRequestPrincipalError: PrincipalError },
    './workspace-file-lifecycle-guard': { WorkspaceFileLifecycleBusyError: BusyError },
    './workspace-operation-batch-store': { WorkspaceOperationBatchError, readWorkspaceOperationBatchClaimBinding: () => state.drift ? { ...binding } : binding },
    '../workspaces/workspace-operation-job-principal': { captureWorkspaceOperationJobPolicy: async () => { state.policies++; return {}; }, withWorkspaceOperationJobPolicyOnConnection: authorize },
    './workspace-operation-job-phase-scheduling': { withWorkspaceOperationJobClaimPhase: <T>(actual: WorkspaceOperationBatchClaim, operation: () => Promise<T>) => phase(actual, async () => {
      state.phase++; try { return await operation(); } finally { state.phase--; }
    }) },
    '../collaboration/native-inspection-schema': { withNativeInspectionSchema: async <T>(operation: () => Promise<T>) => { state.schema++; try { return await operation(); } finally { state.schema--; } } },
    '../collaboration/handoff-execution-context': { hasCollaborationHandoffExecutionContext: () => false },
    '../collaboration/lifecycle-transaction': { executeLifecycleTransaction },
    './workspace-operation-native-move-plan': { decodeWorkspaceOperationNativeMoveBatchPlan: () => plan },
    './workspace-operation-mixed-source-evidence': { workspaceOperationSourceNativeEvidence: () => ({ nativeBindings: [] }) },
    './workspace-operation-original-move': { captureWorkspaceOperationOriginalMoveContext: (value: unknown) => value },
    './workspace-operation-original-move-repository': { readWorkspaceOperationOriginalMoveIntentOnConnection: async () => null },
    './workspace-operation-original-move-storage': { bindWorkspaceOperationOriginalMoveStorageOnConnection: async () => storage },
    './workspace-operation-original-move-admission': { createWorkspaceOperationOriginalMoveAdmissionRequestFromBundle: () => request },
    './workspace-operation-job-scope': { captureWorkspaceOperationJobScope: () => scope, workspaceOperationJobScopeMatches: () => true },
    '../collaboration/room-admission-contract': { CollaborationAdmissionError: AdmissionError, collaborationAdmissionLockKey: () => '1',
      captureCollaborationAdmissionRequest: () => ({ request, requestDigest: 'a'.repeat(64), intentText: 'declared' }) },
    '../collaboration/room-admission': { tryLockCollaborationAdmissionWorkspace: async () => undefined },
    '../collaboration/runtime-state': { getCollaborationRoomConnectionCount: () => 0 },
    './workspace-mutation-lock': { withWorkspaceMutationLock: async <T>(_id: string, operation: () => Promise<T>) => { state.mutationScope++; try { return await operation(); } finally { state.mutationScope--; } } },
    'node:timers/promises': { setTimeout: async (milliseconds: number) => { clean(); assert.equal(state.events.at(-1), 'resume');
      assert(milliseconds > 0 && milliseconds <= 50); state.sleeps.push(milliseconds); state.now += milliseconds; } },
  };
  const require = createRequire(`${process.cwd()}/package.json`);
  const load = async <T>(filename: string): Promise<T> => {
    const compiled = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const exported = {};
    new Function('require', 'module', 'exports', 'performance', 'console', compiled)((name: string) =>
      Object.hasOwn(mocks, name) ? mocks[name] : name.startsWith('node:') ? require(name) : {},
    { exports: exported }, exported, { now: () => state.now }, { info: () => undefined });
    return exported as T;
  };
  const history = await load<typeof import('../app/lib/files/workspace-operation-job-lifecycle-owner')>('app/lib/files/workspace-operation-job-lifecycle-owner.ts');
  const admission = await load<typeof import('../app/lib/files/workspace-operation-native-path-admission')>('app/lib/files/workspace-operation-native-path-admission.ts');
  mocks['./workspace-operation-job-lifecycle-owner'] = { ...history, withWorkspaceOperationNativeMoveJobOwner: async () => {
    clean(); state.ownerCalls++; if (options.ownerFails) throw new BusyError(); return 'declared-owner-result';
  } };
  mocks['./workspace-operation-native-path-admission'] = admission;
  const runner = await load<typeof import('../app/lib/files/workspace-operation-original-move-runner')>('app/lib/files/workspace-operation-original-move-runner.ts');
  const invoke = () => scheduling(claim, { pauseAndDrain: async () => { assert.equal(state.live, 0); state.events.push('pause'); },
    resume: async () => { assert.equal(state.live, 0); assert.equal(state.phase, 0); state.resumes++; await Promise.resolve(); state.events.push('resume');
      if (options.claimFails && state[options.stage] > 0) {
        try { readWorkspaceOperationBatchClaimBinding({} as WorkspaceOperationBatchClaim); } catch { /* The real Store claim remains poisoned. */ }
      }
      if (options.resumeFails && state[options.stage] > 0) throw new BusyError(); if (options.claimChanges) state.drift = true; } },
  () => runner.executeWorkspaceOperationOriginalMove({ claim, workspace: scope as never }));
  return { state, primary, clean, invoke };
}

async function main(): Promise<void> {
  const pinned = await hashes(), sql = new PGlite();
  let openConnections = 0, families = 0;
  const connect = async (): Promise<SqlConnection> => {
    openConnections += 1; let closed = false;
    return {
      get: async (query, values) => (await sql.query(query, values)).rows[0],
      all: async (query, values) => (await sql.query(query, values)).rows,
      run: async (query, values) => { const answer = await sql.query(query, values); return { changes: answer.affectedRows ?? 0 }; },
      close: () => { assert.equal(closed, false); closed = true; openConnections -= 1; },
    };
  };
  const store = new WorkspaceOperationBatchStore(connect);
  const create = async () => {
    const workspaceId = `scheduling-${randomUUID()}`;
    const scope: WorkspaceOperationBatchScope = { workspace: { workspaceId, workspaceType: 'personal',
      ownerUserId: 'scheduling-user', rootPath: `/scheduling-fixture/${workspaceId}`, legacy: false, status: 'active',
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
        canManageWorkspace: true, canRunAgent: true } }, fileOptions: {} };
    scope.fileOptions.workspace = scope.workspace;
    const plan: WorkspaceOperationBatchPlan = { version: 1, workspaceId, planId: 'a'.repeat(64), readiness: 'ready',
      actions: [{ reviewId: 'scheduling-action', kind: 'delete', selections: [{ sourcePath: ' original.md' }] }],
      pathSteps: [{ reviewId: 'scheduling-action', kind: 'delete', sourcePath: ' original.md' }], pathMappings: [],
      deletedPaths: [], linkEdits: [], originalDocuments: [], previewContents: [], expectedPathState: [],
      coverage: { complete: true, omittedSources: [], unresolvedLinks: [] },
      linkAssessment: { version: 1, complete: true, blockers: [], warnings: [] }, issues: [],
      linkPlan: createFixtureWorkspaceOperationLegacyLinkPlan(workspaceId, [{ reviewId: 'scheduling-action', kind: 'delete', selections: [{ sourcePath: ' original.md' }] }]) };
    const row = await store.createDirect({ batchId: randomUUID(), plan, authorization: { mode: 'direct', actorUserId: 'scheduling-user',
      actorId: 'scheduling-user', actorType: 'user', actorDisplayName: 'Scheduling user', requestHash: 'b'.repeat(64),
      jobScope: captureWorkspaceOperationJobScope(scope.workspace) } });
    return { row, scope, plan };
  };
  const runClaim = async <T>(operation: (claim: WorkspaceOperationBatchClaim) => Promise<T>) => {
    await create(); const original = await store.claim(randomUUID()); assert(original);
    return store.withClaim(original, operation);
  };
  const family = async (label: string, operation: () => Promise<void>) => {
    await sql.exec('TRUNCATE workspace_file_operation_reviews,workspace_file_operation_batches');
    await operation(); assert.equal(openConnections, 0); families += 1;
    console.log(`phase scheduling: ${label} passed`);
  };
  try {
    for (const statement of WORKSPACE_OPERATION_REVIEW_STATEMENTS) await sql.exec(statement);

    for (const stage of ['history', 'admission'] as const) {
      await family(`public ${stage} settled Busy closes, resumes and freshly retries before one Owner entry`, async () => {
        await runClaim(async claim => { const probe = await preownerFixture(claim, { stage });
          assert.equal(await probe.invoke(), 'declared-owner-result'); probe.clean();
          assert.equal(probe.state.ownerCalls, 1); assert.equal(probe.state.rollbacks, 1);
          assert.equal(probe.state[stage], 2); assert.deepEqual(probe.state.sleeps, [50]);
          assert.equal(probe.state.policies, probe.state.opened); assert.equal(probe.state.resumes, probe.state.opened);
          assert.match(probe.state.events.join(','), /ROLLBACK,close,resume,.*BEGIN/u);
        });
      });
      for (const fault of ['lookalike', 'auth', 'sql', 'aggregate'] as const) await family(`public ${stage} ${fault} is never retried`, async () => {
        await assert.rejects(runClaim(async claim => { const probe = await preownerFixture(claim, { stage, fault });
          try { await probe.invoke(); } finally { probe.clean(); assert.equal(probe.state[stage], 1); assert.equal(probe.state.ownerCalls, 0); assert.deepEqual(probe.state.sleeps, []); }
        }));
      });
      for (const fence of ['rollbackFails', 'closeFails', 'commitFails', 'resumeFails', 'claimFails'] as const) await family(`public ${stage} ${fence} cannot acquire retry provenance`, async () => {
        await assert.rejects(runClaim(async claim => { const probe = await preownerFixture(claim, { stage, [fence]: true });
          try { await probe.invoke(); } finally { probe.clean(); assert.equal(probe.state[stage], 1); assert.equal(probe.state.ownerCalls, 0); assert.deepEqual(probe.state.sleeps, []); }
        }));
      });
      await family(`public ${stage} fresh authorization revocation after Busy remains terminal`, async () => {
        await assert.rejects(runClaim(async claim => { const probe = await preownerFixture(claim, { stage, authAfterBusy: true });
          try { await probe.invoke(); } finally { probe.clean(); assert.equal(probe.state[stage], 2); assert.equal(probe.state.ownerCalls, 0); assert.deepEqual(probe.state.sleeps, [50]); }
        }), code('PRINCIPAL_AUTH_REVOKED'));
      });
    }
    await family('public History and Admission use one deadline and cannot restart ten seconds', async () => {
      await assert.rejects(runClaim(async claim => { const probe = await preownerFixture(claim, { stage: 'admission', forever: true, cost: 3300 });
        try { await probe.invoke(); } finally { probe.clean(); assert.equal(probe.state.history, 1); assert.equal(probe.state.admission, 2);
          assert.equal(probe.state.ownerCalls, 0); assert.equal(probe.state.now, 10000); assert.deepEqual(probe.state.sleeps, [50, 50]); }
      }), code('COLLABORATION_FILE_LIFECYCLE_BUSY'));
    });
    await family('public History Busy expires its original deadline before another phase', async () => {
      await assert.rejects(runClaim(async claim => { const probe = await preownerFixture(claim, { stage: 'history', forever: true, cost: 3300 });
        try { await probe.invoke(); } finally { probe.clean(); assert.equal(probe.state.history, 3); assert.equal(probe.state.admission, 0);
          assert.equal(probe.state.ownerCalls, 0); assert.equal(probe.state.now, 10000); assert.deepEqual(probe.state.sleeps, [50, 50]); }
      }), code('PRINCIPAL_BUSY'));
    });
    await family('public History later product binding drift after settled Busy cannot reach Owner', async () => {
      await assert.rejects(runClaim(async claim => { const probe = await preownerFixture(claim, { stage: 'history', claimChanges: true });
        try { await probe.invoke(); } finally { probe.clean(); assert.equal(probe.state.ownerCalls, 0); assert.equal(probe.state.history, 2); }
      }), code('JOB_LIFECYCLE_CHANGED'));
    });
    await family('public runner never retries Owner or FS work after pre-owner Busy recovery', async () => {
      await assert.rejects(runClaim(async claim => { const probe = await preownerFixture(claim, { stage: 'history', ownerFails: true });
        try { await probe.invoke(); } finally { probe.clean(); assert.equal(probe.state.ownerCalls, 1); assert.equal(probe.state.history, 2); assert.deepEqual(probe.state.sleeps, [50]); }
      }), code('COLLABORATION_FILE_LIFECYCLE_BUSY'));
    });
    await family('agent Principal Busy does not adopt the new direct human retry behavior', async () => {
      await assert.rejects(runClaim(async claim => { const probe = await preownerFixture(claim, { stage: 'history', nonhuman: true });
        try { await probe.invoke(); } finally { probe.clean(); assert.equal(probe.state.history, 1); assert.equal(probe.state.ownerCalls, 0); assert.deepEqual(probe.state.sleeps, []); }
      }), code('PRINCIPAL_BUSY'));
    });

    await family('standalone real claim permits consecutive phases without minting a schedule', async () => {
      await runClaim(async claim => {
        assert.equal(await phase(claim, async () => 'first'), 'first');
        assert.equal(await phase(claim, async () => 'second'), 'second');
      });
    });
    await family('forged claim cannot register or reach a phase callback', async () => {
      let reached = false;
      await assert.rejects(runClaim(async () => {
        await assert.rejects(scheduling({} as WorkspaceOperationBatchClaim, noScheduling, async () => { reached = true; }), code('BATCH_CLAIM_REQUIRED'));
      }), code('BATCH_CLAIM_REQUIRED'));
      await assert.rejects(phase({} as WorkspaceOperationBatchClaim, async () => { reached = true; }), code('BATCH_CLAIM_REQUIRED'));
      assert.equal(reached, false);
    });
    await family('registered serial phases pause resume and finally drain in order', async () => {
      const order: string[] = [];
      await runClaim(claim => scheduling(claim, { pauseAndDrain: async () => { order.push('pause'); },
        resume: async () => { order.push('resume'); } }, async () => {
        assert.equal(await phase(claim, async () => { order.push('phase1'); return 1; }), 1);
        order.push('fs'); await phase(claim, async () => { order.push('phase2'); });
      }));
      assert.deepEqual(order, ['pause', 'phase1', 'resume', 'fs', 'pause', 'phase2', 'resume', 'pause']);
    });
    await family('inflight pause is actually drained before operation enters', async () => {
      const started = deferred(), release = deferred(); let entered = false;
      await runClaim(claim => scheduling(claim, { pauseAndDrain: async () => { started.resolve(); await release.promise; },
        resume: async () => undefined }, async () => {
        const pending = phase(claim, async () => { entered = true; });
        await started.promise; assert.equal(entered, false); release.resolve(); await pending;
      }));
      assert.equal(entered, true);
    });
    await family('caught nested phase poisons the registered invocation', async () => {
      await assert.rejects(runClaim(claim => scheduling(claim, noScheduling, async () => {
        await assert.rejects(phase(claim, async () => {
          await assert.rejects(phase(claim, async () => assert.fail('nested phase entered')), code('JOB_PHASE_SCHEDULING_REENTRANT'));
        }), code('JOB_PHASE_SCHEDULING_REENTRANT'));
      })), code('JOB_PHASE_SCHEDULING_REENTRANT'));
    });
    await family('parallel phase from sibling context poisons and drains original phase', async () => {
      const started = deferred(), release = deferred(); let settled = false;
      await assert.rejects(runClaim(claim => scheduling(claim, noScheduling, async () => {
        const original = phase(claim, async () => { started.resolve(); await release.promise; settled = true; });
        await started.promise;
        await assert.rejects(phase(claim, async () => assert.fail('parallel phase entered')), code('JOB_PHASE_SCHEDULING_REENTRANT'));
        release.resolve(); await assert.rejects(original, code('JOB_PHASE_SCHEDULING_REENTRANT'));
      })), code('JOB_PHASE_SCHEDULING_REENTRANT'));
      assert.equal(settled, true);
    });
    await family('detached phase is awaited and cannot produce success', async () => {
      const started = deferred(), release = deferred(), returning = deferred(); let finished = false;
      const pending = runClaim(claim => scheduling(claim, noScheduling, async () => {
        void phase(claim, async () => { started.resolve(); await release.promise; finished = true; }).catch(() => undefined);
        await started.promise; returning.resolve();
      }));
      await returning.promise; assert.equal(finished, false); release.resolve();
      await assert.rejects(pending, code('JOB_PHASE_SCHEDULING_DETACHED')); assert.equal(finished, true);
    });
    await family('retained registered phase cannot fall back to standalone before claim closes', async () => {
      await runClaim(async claim => {
        let retained!: () => Promise<void>;
        await scheduling(claim, noScheduling, async () => { retained = () => phase(claim, async () => assert.fail('retained phase entered')); });
        await assert.rejects(retained(), code('JOB_PHASE_SCHEDULING_REQUIRED'));
      });
    });
    await family('retained phase context cannot enter a new phase after settlement', async () => {
      const late = deferred(); let escaped: Promise<void> | undefined;
      await runClaim(async claim => {
        await scheduling(claim, noScheduling, async () => {
          await phase(claim, async () => {
            escaped = (async () => { await late.promise; await assert.rejects(phase(claim,
              async () => assert.fail('escaped phase entered')), code('JOB_PHASE_SCHEDULING_REENTRANT')); })();
          });
        });
        late.resolve(); await escaped;
      });
    });
    await family('invalid hook accessors are not invoked', async () => {
      let touched = false;
      await assert.rejects(runClaim(claim => scheduling(claim, { get pauseAndDrain() { touched = true; return async () => undefined; },
        resume: async () => undefined }, async () => assert.fail('invalid hooks entered'))), code('JOB_PHASE_SCHEDULING_REQUIRED'));
      assert.equal(touched, false);
    });
    for (const value of [undefined, null, false]) await family(`non-Error callback rejection ${String(value)} stays failed`, async () => {
      await assert.rejects(runClaim(claim => scheduling(claim, noScheduling, () => phase(claim, async () => { throw value; }))),
        code('JOB_PHASE_SCHEDULING_FAILED'));
    });
    await family('ordinary primary identity survives successful cleanup', async () => {
      const primary = new Error('Expected controlled primary failure.');
      await assert.rejects(runClaim(claim => scheduling(claim, noScheduling, () => phase(claim, async () => { throw primary; }))),
        error => error === primary);
    });
    await family('uncertain primary status and code survive resume and final drain failures', async () => {
      const primary = Object.assign(new Error('Controlled uncertain phase result.'), { code: 'JOB_LIFECYCLE_COMMIT_UNCONFIRMED', status: 503 });
      const resumed = Object.assign(new Error('Controlled resume failure.'), { code: 'RESUME_FAILED', status: 409 });
      const drained = new Error('Controlled final drain failure.'); let pauses = 0;
      await assert.rejects(runClaim(claim => scheduling(claim, { pauseAndDrain: async () => { if (++pauses === 2) throw drained; },
        resume: async () => { throw resumed; } }, () => phase(claim, async () => { throw primary; }))), error => {
        assert(error instanceof AggregateError); assert.equal(Object.getOwnPropertyDescriptor(error, 'status')?.value, 503);
        assert.equal(Object.getOwnPropertyDescriptor(error, 'code')?.value, 'JOB_LIFECYCLE_COMMIT_UNCONFIRMED');
        for (const expected of [primary, resumed, drained]) assert(includesError(error, expected)); return true;
      });
    });
    await family('uncertain cleanup upgrades a confirmed ordinary primary failure', async () => {
      const primary = Object.assign(new Error('Controlled ordinary failure.'), { code: 'ORDINARY_FAILURE', status: 409 });
      const cleanup = Object.assign(new Error('Controlled unconfirmed disposal.'), { code: 'DISPOSAL_UNCONFIRMED', status: 503 });
      await assert.rejects(runClaim(claim => scheduling(claim, { pauseAndDrain: async () => undefined,
        resume: async () => { throw cleanup; } }, () => phase(claim, async () => { throw primary; }))), error => {
        assert(error instanceof AggregateError); assert.equal(Object.getOwnPropertyDescriptor(error, 'status')?.value, 503);
        assert.equal(Object.getOwnPropertyDescriptor(error, 'code')?.value, 'DISPOSAL_UNCONFIRMED');
        assert(includesError(error, primary)); assert(includesError(error, cleanup)); return true;
      });
    });
    await family('caught late phase during final asynchronous cleanup still rejects', async () => {
      await assert.rejects(runClaim(async claim => {
        let finalPause = false;
        await scheduling(claim, { pauseAndDrain: async () => {
          if (finalPause) await assert.rejects(phase(claim, async () => assert.fail('late cleanup phase entered')),
            code('JOB_PHASE_SCHEDULING_REQUIRED'));
        }, resume: async () => undefined }, async () => { finalPause = true; });
      }), code('JOB_PHASE_SCHEDULING_REQUIRED'));
    });
    await family('actual Worker drains periodic heartbeat then renews between complete phases', async () => {
      const fixture = await create(), timers = manualWorkerIntervals();
      const heartbeat = store.heartbeatClaim.bind(store), renewalStarted = deferred(), renewalRelease = deferred();
      let insidePhase = false, hold = false, heartbeats = 0, lastHeartbeat: Promise<boolean> | undefined;
      store.heartbeatClaim = (original, progress) => {
        lastHeartbeat = (async () => {
          assert.equal(insidePhase, false, 'no heartbeat starts while the bounded phase is active'); heartbeats += 1;
          if (hold) { hold = false; renewalStarted.resolve(); await renewalRelease.promise; }
          return heartbeat(original, progress);
        })(); return lastHeartbeat;
      };
      try {
        const worker = createWorkspaceOperationBatchWorker({ store, resolveScope: async () => fixture.scope,
          lock: async (_workspaceId, operation) => operation(), buildPlan: async () => fixture.plan,
          hasExecution: async () => false, dependentReviews: async () => undefined, projectFileViews: () => undefined,
          execute: async input => {
            assert(input.jobClaim); const before = heartbeats, oldInterval = timers.first();
            hold = true; oldInterval(); await renewalStarted.promise;
            const cleared = deferred(), entered = deferred(), phaseRelease = deferred();
            timers.observeClear(cleared.resolve); let enteredPhase = false;
            const pending = phase(input.jobClaim, async () => {
              enteredPhase = true; insidePhase = true; entered.resolve();
              try { await phaseRelease.promise; } finally { insidePhase = false; }
            });
            await cleared.promise; assert.equal(enteredPhase, false); assert.equal(timers.size, 0);
            renewalRelease.resolve(); await entered.promise; const pausedCount = heartbeats;
            oldInterval(); await Promise.resolve(); assert.equal(heartbeats, pausedCount);
            phaseRelease.resolve(); await pending; assert.equal(heartbeats, before + 2); assert.equal(timers.size, 1);
            timers.first()(); await lastHeartbeat; assert.equal(heartbeats, before + 3, 'periodic renewal remains enabled during later FS work');
            await phase(input.jobClaim, async () => { insidePhase = true; assert.equal(timers.size, 0); insidePhase = false; });
            assert.equal(heartbeats, before + 4); return result;
          } });
        assert.equal(await worker.tick(), true); assert.equal(timers.size, 0);
        assert.equal((await store.get(fixture.row.batchId))?.status, 'applied');
      } finally { store.heartbeatClaim = heartbeat; timers.restore(); }
    });
    await family('actual Worker cannot finish success after a caught phase failure', async () => {
      const fixture = await create(), primary = new WorkspaceOperationJobPhaseSchedulingError('JOB_PHASE_SCHEDULING_FAILED');
      let projections = 0;
      const worker = createWorkspaceOperationBatchWorker({ store, resolveScope: async () => fixture.scope,
        lock: async (_workspaceId, operation) => operation(), buildPlan: async () => fixture.plan,
        hasExecution: async () => true, mutationEvidence: async () => 'started',
        dependentReviews: async () => assert.fail('failed execution cannot update dependent reviews'),
        projectFileViews: () => { projections += 1; }, execute: async input => {
          assert(input.jobClaim); await assert.rejects(phase(input.jobClaim, async () => { throw primary; }), error => error === primary);
          return result;
        } });
      assert.equal(await worker.tick(), true); assert.equal(projections, 0);
      const persisted = await store.get(fixture.row.batchId); assert(persisted);
      assert.equal(persisted.status, 'needs_recovery'); assert.equal(persisted.errorCode, primary.code);
    });
    await family('Undo OFF rejects enqueue unchanged and quarantines a saved Undo before all work', async () => {
      const { WORKSPACE_FILE_UNDO_ENABLED, WorkspaceFileUndoDisabledError } = await import('../app/lib/files/workspace-file-undo-policy');
      assert.equal(WORKSPACE_FILE_UNDO_ENABLED, false);
      const fixture = await create(), original = await store.claim(randomUUID()); assert(original);
      await store.finish(original.batchId, original.leaseOwner!, { status: 'applied', completedActions: 1, phase: 'complete' });
      const enqueue = { batchId: fixture.row.batchId, planId: fixture.plan.planId,
        userId: 'scheduling-user', displayName: 'Scheduling user' };
      const disabled = (error: unknown) => error instanceof WorkspaceFileUndoDisabledError
        && error.code === 'FILE_OPERATION_UNDO_DISABLED' && error.status === 409;
      const snapshot = async () => ({
        batches: (await sql.query('SELECT *, xmin::text AS row_xmin FROM workspace_file_operation_batches ORDER BY batch_id')).rows,
        reviews: (await sql.query('SELECT *, xmin::text AS row_xmin FROM workspace_file_operation_reviews ORDER BY review_id')).rows,
      });
      const before = await snapshot(), completed = await store.get(fixture.row.batchId); assert(completed);
      assert.equal(completed.status, 'applied'); assert.equal(completed.actionMode, 'apply'); assert.equal(completed.completedActions, 1);
      await assert.rejects(store.enqueue({ ...enqueue, action: 'undo' }), disabled);
      assert.deepEqual(await snapshot(), before, 'OFF enqueue preserves all rows and xmin');
      const timers = manualWorkerIntervals(); let callbacks = 0;
      const forbidden = () => { callbacks++; assert.fail('Undo OFF must stop before scope, locks, probes, execution or file views.'); };
      try {
        const worker = createWorkspaceOperationBatchWorker({ store, resolveScope: async () => forbidden(),
          lock: async () => forbidden(), buildPlan: async () => forbidden(), hasExecution: async () => forbidden(),
          mutationEvidence: async () => forbidden(), execute: async () => forbidden(), undo: async () => forbidden(),
          dependentReviews: async () => forbidden(), projectFileViews: forbidden });
        assert.equal(await worker.tick(), false); assert.equal(callbacks, 0); assert.equal(timers.size, 0);
        assert.deepEqual(await snapshot(), before, 'an idle worker cannot mutate the completed forward batch');
        // Declared historical queue state only: never enable Undo or call its
        // public enqueue gate to fabricate an accepted restore operation.
        await sql.query("UPDATE workspace_file_operation_batches SET status='queued',action_mode='undo',phase='recovery' WHERE batch_id=$1", [fixture.row.batchId]);
        assert.equal(await worker.tick(), true); assert.equal(callbacks, 0); assert.equal(timers.size, 0);
        const refused = await store.get(fixture.row.batchId); assert(refused);
        assert.equal(refused.status, 'needs_recovery'); assert.equal(refused.phase, 'recovery');
        assert.equal(refused.errorCode, 'FILE_OPERATION_UNDO_DISABLED'); assert.equal(refused.actionMode, 'undo');
        assert.equal(refused.leaseOwner, null);
        assert.equal((await sql.query<{ lease_expires_at: null }>('SELECT lease_expires_at FROM workspace_file_operation_batches WHERE batch_id=$1', [refused.batchId])).rows[0]?.lease_expires_at, null);
        assert.equal(refused.completedActions, completed.completedActions); assert.equal(refused.totalActions, completed.totalActions);
        assert.deepEqual(refused.plan, completed.plan); assert.deepEqual(refused.authorization, completed.authorization);
        assert.deepEqual(refused.trashEntryIds, completed.trashEntryIds);
        const recovery = await snapshot();
        await assert.rejects(store.enqueue({ ...enqueue, action: 'resume' }), disabled);
        assert.deepEqual(await snapshot(), recovery, 'OFF resume preserves the saved Undo recovery and receipts');
        assert.equal(await worker.tick(), false); assert.equal(callbacks, 0); assert.equal(timers.size, 0);
      } finally { timers.restore(); }
    });
    console.log(`phase scheduling: ${families} embedded SQL and controlled scheduling families passed`);
  } finally {
    try { assert.equal(openConnections, 0); await sql.close(); }
    finally { assert.deepEqual(await hashes(), pinned); }
  }
}

void runPgliteFixture({ label: 'workspace-operation-job-phase-scheduling-test', operation: main,
  successMessage: 'workspace-operation-job-phase-scheduling-test: all scheduling assertions and cleanup passed' });
