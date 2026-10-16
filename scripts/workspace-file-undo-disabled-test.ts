import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import ts from 'typescript';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceOperationLegacyBatchPlan, WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import type { WorkspaceOperationBatchRecord } from '../app/lib/files/workspace-operation-batch-store';

// Real exported function bodies and a real embedded SQL Store/claim are tested.
// Auth, kernel and Execute adapters below are explicit boundary controls; they
// prove no current rights, PostgreSQL concurrency or physical/native Delete.
const pins = new Map<string, string>();
const require = createRequire(path.resolve('package.json'));
const unexpected: string[] = [];
const forbidden = (label: string) => (..._args: unknown[]): never => { unexpected.push(label); throw new Error(`Unexpected boundary: ${label}`); };
const opaqueDependency = (name: string) => new Proxy({}, { get: (_target, key) => key === '__esModule' ? true : forbidden(`${name}.${String(key)}`) });
async function sourceModule<T>(relative: string, dependencies: Record<string, unknown> = {}): Promise<T> {
  const filename = path.resolve(relative), bytes = await readFile(filename);
  pins.set(filename, createHash('sha256').update(bytes).digest('hex'));
  const javascript = ts.transpileModule(bytes.toString(), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', javascript)((name: string) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    if (name === 'server-only') return {};
    if (name.startsWith('node:')) return require(name);
    return opaqueDependency(name);
  }, loaded, loaded.exports);
  return loaded.exports as T;
}

async function main(): Promise<void> {
  let completed = false, families = 0;
  const watchdog = setTimeout(() => { console.error('Undo-disabled fixture did not complete.'); process.exitCode = 1; }, 45_000);
  const check = async (label: string, operation: () => Promise<void> | void) => {
    await operation(); assert.deepEqual(unexpected, []); families++; console.log(`Undo-disabled boundary passed: ${label}`);
  };
  const policy = await sourceModule<typeof import('../app/lib/files/workspace-file-undo-policy')>('app/lib/files/workspace-file-undo-policy.ts');
  const disabled = (error: unknown) => error instanceof policy.WorkspaceFileUndoDisabledError
    && error.code === 'FILE_OPERATION_UNDO_DISABLED' && error.status === 409;
  const scope: WorkspaceOperationBatchScope = { workspace: { workspaceId: 'undo-disabled-workspace', workspaceType: 'personal',
    rootPath: '/owned-boundary/workspace', rootRelativePath: 'workspaces/personal/undo-user/files', ownerUserId: 'undo-user',
    organizationId: null, customerId: null, projectId: null, status: 'active', legacy: false,
    actor: { userId: 'undo-user', role: 'member' }, permissions: { canRead: true, canWrite: true, canDelete: true,
      canCreatePublicLinks: false, canManageWorkspace: true, canRunAgent: true } }, fileOptions: {} };
  const policyDependency = { './workspace-file-undo-policy': policy,
    '@/app/lib/files/workspace-file-undo-policy': policy };
  const pg = new PGlite();
  try {
    await check('fixed default is off and the actual guard throws the known 409', () => {
      assert.equal(policy.WORKSPACE_FILE_UNDO_ENABLED, false);
      assert.throws(() => policy.assertWorkspaceFileUndoEnabled(), disabled);
    });
    const legacy = await sourceModule<typeof import('../app/lib/files/workspace-operation-undo-service')>(
      'app/lib/files/workspace-operation-undo-service.ts', policyDependency);
    await check('legacy Undo fails before even reading the request or reaching any dependency', async () => {
      const input = new Proxy({}, { get: forbidden('legacy input read') });
      await assert.rejects(legacy.undoWorkspaceFileOperation(input as Parameters<typeof legacy.undoWorkspaceFileOperation>[0]), disabled);
    });
    await check('legacy capability remains explicitly unavailable without journal, FS or SQL access', async () => {
      const input = new Proxy({}, { get: forbidden('legacy capability input read') });
      assert.deepEqual(await legacy.getWorkspaceOperationUndoCapability(input as Parameters<typeof legacy.getWorkspaceOperationUndoCapability>[0]), {
        available: false, reason: new policy.WorkspaceFileUndoDisabledError().message,
        reasonCode: 'FILE_OPERATION_UNDO_DISABLED', undoOperationId: null,
      });
    });
    const executor = await sourceModule<typeof import('../app/lib/files/workspace-operation-batch-executor')>(
      'app/lib/files/workspace-operation-batch-executor.ts', { ...policyDependency,
        '@/app/lib/runtime-data-paths': { resolveCanvasDataRoot: () => '/owned-boundary/no-io' } });
    await check('batch Undo and availability stop before claim lookup, manifest IO or lifecycle work', async () => {
      const boundary = executor.createWorkspaceOperationBatchExecutor();
      const input = new Proxy({}, { get: forbidden('executor input read') });
      await assert.rejects(boundary.undo(input as Parameters<typeof boundary.undo>[0]), disabled);
      await assert.rejects(boundary.assertUndoAvailable(input as Parameters<typeof boundary.assertUndoAvailable>[0]), disabled);
      await assert.rejects(executor.undoWorkspaceOperationBatch(input as Parameters<typeof executor.undoWorkspaceOperationBatch>[0]), disabled);
      await assert.rejects(executor.assertWorkspaceOperationBatchUndoAvailable(input as Parameters<typeof executor.assertWorkspaceOperationBatchUndoAvailable>[0]), disabled);
    });
    const identity = await sourceModule<typeof import('../app/lib/workspaces/path-identity')>('app/lib/workspaces/path-identity.ts');
    const jobScope = await sourceModule<typeof import('../app/lib/files/workspace-operation-job-scope')>('app/lib/files/workspace-operation-job-scope.ts', {
      '@/app/lib/workspaces/path-identity': identity,
    });
    const lifecycle = await sourceModule<typeof import('../app/lib/collaboration/lifecycle-transaction')>('app/lib/collaboration/lifecycle-transaction.ts');
    const stores = await sourceModule<typeof import('../app/lib/files/workspace-operation-batch-store')>('app/lib/files/workspace-operation-batch-store.ts', {
      ...policyDependency,
      '@/app/lib/db': { openDb: forbidden('shared PostgreSQL checkout') },
      '@/app/lib/collaboration/lifecycle-transaction': lifecycle, './workspace-operation-job-scope': jobScope,
    });
    const migration = await sourceModule<typeof import('../app/lib/db/workspace-operation-review-migration')>('app/lib/db/workspace-operation-review-migration.ts');
    for (const statement of migration.WORKSPACE_OPERATION_REVIEW_STATEMENTS) await pg.exec(statement);
    let connections = 0;
    const connect = async (): Promise<SqlConnection> => { connections++; return {
      get: async (sql, values) => (await pg.query(sql, values)).rows[0],
      all: async (sql, values) => (await pg.query(sql, values)).rows,
      run: async (sql, values) => pg.query(sql, values), close: () => undefined,
    }; };
    const store = new stores.WorkspaceOperationBatchStore(connect);
    // This declared V1 DTO exercises queue/claim policy, not plan compilation or
    // file authority. All fields required by the actual legacy codec are real data.
    const plan: WorkspaceOperationLegacyBatchPlan = { version: 1, workspaceId: scope.workspace.workspaceId, planId: 'a'.repeat(64), readiness: 'ready',
      actions: [{ reviewId: 'undo-boundary-action', kind: 'delete', selections: [{ sourcePath: 'original.bin' }] }],
      pathSteps: [{ reviewId: 'undo-boundary-action', kind: 'delete', sourcePath: 'original.bin' }],
      pathMappings: [], deletedPaths: [], linkEdits: [], originalDocuments: [], previewContents: [], expectedPathState: [],
      coverage: { complete: true, omittedSources: [], unresolvedLinks: [] }, issues: [],
      linkAssessment: { version: 1, complete: true, blockers: [], warnings: [] },
      linkPlan: { contractVersion: 1, status: 'planned', kind: 'delete', planId: 'b'.repeat(64), readiness: 'ready', recoveryReady: true,
        pathMappings: [], linkEdits: [], expectedPathState: [], collisions: [], issues: [], previewContents: [],
        coverage: { complete: true, omittedSources: [], unresolvedLinks: [] } } as WorkspaceOperationLegacyBatchPlan['linkPlan'],
    };
    const seed = () => store.createDirect({ batchId: randomUUID(), plan, authorization: { mode: 'direct', actorUserId: 'undo-user', actorId: 'undo-user',
      actorType: 'user', actorDisplayName: 'Boundary user', requestHash: 'c'.repeat(64), jobScope: jobScope.captureWorkspaceOperationJobScope(scope.workspace) } });
    let selected: WorkspaceOperationBatchRecord | null = null, enqueues = 0, locks = 0, refreshes = 0, probes = 0;
    class ServiceStore {
      async get() { return selected; }
      async enqueue(input: Parameters<typeof store.enqueue>[0]) { enqueues++; return store.enqueue(input); }
    }
    const service = await sourceModule<typeof import('../app/lib/files/workspace-operation-batch-service')>('app/lib/files/workspace-operation-batch-service.ts', {
      ...policyDependency, './workspace-operation-batch-store': { ...stores, WorkspaceOperationBatchStore: ServiceStore },
      './workspace-operation-batch-plan': { workspaceOperationBatchPublicPreview: () => ({ version: 1, planId: plan.planId }) },
      './workspace-operation-batch-executor': { assertWorkspaceOperationBatchUndoAvailable: async () => { probes++; },
        getWorkspaceOperationBatchExecutionPublic: async () => undefined },
      './workspace-mutation-lock': { withWorkspaceMutationLock: async (_id: string, action: () => Promise<unknown>) => { locks++; return action(); } },
    });
    const queue = (action: 'undo' | 'resume') => service.enqueueWorkspaceOperationBatch({ batchId: selected!.batchId, planId: selected!.planId,
      scope, userId: 'undo-user', displayName: 'Boundary user', action,
      refreshScope: async () => { refreshes++; return scope; } });
    await check('new Undo and a historical resume-Undo cannot enqueue or enter a mutation lock', async () => {
      selected = await seed();
      await pg.query("UPDATE workspace_file_operation_batches SET status='applied',phase='complete',completed_actions=1 WHERE batch_id=$1", [selected.batchId]);
      selected = await store.get(selected.batchId); const before = await pg.query('SELECT * FROM workspace_file_operation_batches');
      await assert.rejects(queue('undo'), disabled);
      await pg.query("UPDATE workspace_file_operation_batches SET action_mode='undo',status='needs_recovery',phase='recovery' WHERE batch_id=$1", [selected!.batchId]);
      selected = await store.get(selected!.batchId); const undoBefore = await pg.query('SELECT * FROM workspace_file_operation_batches');
      await assert.rejects(queue('resume'), disabled);
      assert.deepEqual((await pg.query('SELECT * FROM workspace_file_operation_batches')).rows, undoBefore.rows);
      assert.equal(before.rows.length, 1); assert.equal(enqueues, 0); assert.equal(locks, 0); assert.equal(refreshes, 0); assert.equal(probes, 0);
    });
    await check('actual Store denies new Undo before SQL and historical Undo resume before any durable change', async () => {
      const input = { batchId: selected!.batchId, planId: selected!.planId, userId: 'undo-user', displayName: 'Boundary user' };
      const before = await pg.query('SELECT * FROM workspace_file_operation_batches'); const opened = connections;
      await assert.rejects(store.enqueue({ ...input, action: 'undo' }), disabled); assert.equal(connections, opened);
      await assert.rejects(store.enqueue({ ...input, action: 'resume' }), disabled);
      assert.deepEqual((await pg.query('SELECT * FROM workspace_file_operation_batches')).rows, before.rows);
    });
    await check('applied batch capability stays false without calling the old Undo probe', async () => {
      selected = { ...selected!, actionMode: 'apply', status: 'applied' };
      const output = await service.getWorkspaceOperationBatchReview(selected.batchId, scope); assert(output);
      assert.equal(output.undoAvailable, false); assert.equal(probes, 0);
    });
    const scheduling = await sourceModule<typeof import('../app/lib/files/workspace-operation-job-phase-scheduling')>(
      'app/lib/files/workspace-operation-job-phase-scheduling.ts', { './workspace-operation-batch-store': stores });
    const failure = await sourceModule<typeof import('../app/lib/files/workspace-operation-batch-failure')>('app/lib/files/workspace-operation-batch-failure.ts');
    const workers = await sourceModule<typeof import('../app/lib/files/workspace-operation-batch-worker')>('app/lib/files/workspace-operation-batch-worker.ts', {
      ...policyDependency, './workspace-operation-batch-store': stores, './workspace-operation-job-scope': jobScope,
      './workspace-operation-job-phase-scheduling': scheduling, './workspace-operation-batch-failure': failure,
    });
    await check('actual SQL queued Undo claim is retired as explicit recovery with no scope or executor access', async () => {
      await pg.query("UPDATE workspace_file_operation_batches SET status='queued',action_mode='undo',phase='recovery' WHERE batch_id=$1", [selected!.batchId]);
      const worker = workers.createWorkspaceOperationBatchWorker({ store,
        resolveScope: forbidden('Undo current-scope lookup'), lock: forbidden('Undo workspace lock'),
        execute: forbidden('Undo apply executor'), undo: forbidden('Undo executor'),
        mutationEvidence: forbidden('Undo mutation probe'), dependentReviews: forbidden('Undo dependent review') });
      assert.equal(await worker.tick(), true);
      const result = await store.get(selected!.batchId); assert(result);
      assert.equal(result.status, 'needs_recovery'); assert.equal(result.phase, 'recovery'); assert.equal(result.errorCode, 'FILE_OPERATION_UNDO_DISABLED');
      assert.equal(result.actionMode, 'undo'); assert.equal(result.leaseOwner, null);
    });
    await check('ordinary Delete Apply still dispatches under an actual SQL claim and finishes applied', async () => {
      // A separate Apply job proves the off-switch does not turn forward Apply
      // into an Undo request. Its Execute adapter is not a physical receipt.
      await pg.exec('TRUNCATE workspace_file_operation_batches'); selected = await seed();
      let executions = 0, passedClaim = false;
      const worker = workers.createWorkspaceOperationBatchWorker({ store, resolveScope: async () => scope,
        lock: async (_id, action) => action(), hasExecution: async () => false, mutationEvidence: async () => 'absent', buildPlan: async () => plan,
        execute: async input => { executions++; assert.equal(input.plan.pathSteps[0].kind, 'delete'); assert(input.jobClaim);
          const binding = stores.readWorkspaceOperationBatchClaimBinding(input.jobClaim); passedClaim = binding.batchId === selected!.batchId && binding.actionMode === 'apply';
          await input.onProgress?.({ phase: 'paths', completedActions: 0, totalActions: 1 });
          return { status: 'applied', completedActions: 1, totalActions: 1, errorCode: null, trashEntryIds: ['declared-delete-receipt'] }; },
        undo: forbidden('Apply invoking Undo'), dependentReviews: async () => undefined, projectFileViews: () => undefined });
      assert.equal(await worker.tick(), true); assert.equal(executions, 1); assert.equal(passedClaim, true);
      const result = await store.get(selected.batchId); assert.equal(result?.status, 'applied'); assert.equal(result?.completedActions, 1);
      assert.equal(result?.phase, 'complete'); assert.equal(result?.errorCode, null);
    });
    await check('Apply recovery enqueue remains possible while Undo recovery is disabled', async () => {
      await pg.query("UPDATE workspace_file_operation_batches SET status='needs_recovery',phase='recovery' WHERE batch_id=$1", [selected!.batchId]);
      selected = await store.get(selected!.batchId); const output = await queue('resume');
      assert.equal(output.status, 'queued'); assert.equal(enqueues, 1); assert.equal(locks, 1); assert.equal(refreshes, 1); assert.equal(probes, 0);
    });
    const jsonError = (message: string, status: number, extra?: object) => Response.json({ success: false, error: message, ...extra }, { status });
    const statusRoute = await sourceModule<typeof import('../app/api/files/operations/batches/[batchId]/route')>(
      'app/api/files/operations/batches/[batchId]/route.ts', { ...policyDependency,
        '@/app/lib/auth': { auth: { api: { getSession: async () => ({ user: { id: 'undo-user' } }) } } },
        '@/app/lib/files/workspace-operation-batch-store': { ...stores, WorkspaceOperationBatchStore: ServiceStore },
        '@/app/lib/workspaces/request': { requireSessionWorkspace: async () => ({ workspace: scope.workspace }), workspaceFileOptions: () => ({}) },
        '@/app/lib/files/workspace-path-operation-response': { workspacePathOperationResponse: async () => ({ operation: { batchId: selected!.batchId } }) },
        '@/app/lib/api/route-helpers': { applyRateLimit: () => null, jsonError, jsonSuccess: (value: unknown) => Response.json(value) },
      });
    await check('actual batch status flags forbid Undo and Undo resume but preserve Apply resume', async () => {
      for (const [status, actionMode, canResume] of [['applied', 'apply', false], ['needs_recovery', 'undo', false], ['needs_recovery', 'apply', true]] as const) {
        selected = { ...selected!, status, actionMode };
        const response = await statusRoute.GET(new Request('http://localhost/api/files/operations/batches/owned') as Parameters<typeof statusRoute.GET>[0],
          { params: Promise.resolve({ batchId: selected.batchId }) });
        assert.equal(response.status, 200); const body = await response.json(); assert.deepEqual(body.recovery, { canResume, canUndo: false });
      }
      assert.equal(probes, 0);
    });
    const route = await sourceModule<typeof import('../app/api/files/trash/[entryId]/restore/route')>(
      'app/api/files/trash/[entryId]/restore/route.ts', { ...policyDependency,
        '@/app/lib/workspaces/request': { requireRequestWorkspace: async () => ({ workspace: scope.workspace, session: { user: { id: 'undo-user' } } }) },
        '@/app/lib/api/route-helpers': { applyRateLimit: () => null, jsonError },
      });
    await check('Trash restore route exposes known 409 without physical restore, collaboration write or audit success', async () => {
      const response = await route.POST(new Request('http://localhost/api/files/trash/owned/restore') as Parameters<typeof route.POST>[0],
        { params: Promise.resolve({ entryId: 'owned-trash' }) });
      assert.equal(response.status, 409); const body = await response.json(); assert.equal(body.success, false); assert.equal(body.code, 'FILE_OPERATION_UNDO_DISABLED');
    });
    const mobileRoute = await sourceModule<typeof import('../app/api/mobile/v1/files/trash/[entryId]/restore/route')>(
      'app/api/mobile/v1/files/trash/[entryId]/restore/route.ts', { '@/app/api/files/trash/[entryId]/restore/route': route });
    await check('Mobile Trash restore reexports the same gated handler', async () => {
      assert.equal(mobileRoute.POST, route.POST);
      const response = await mobileRoute.POST(new Request('http://localhost/api/mobile/v1/files/trash/owned/restore') as Parameters<typeof mobileRoute.POST>[0],
        { params: Promise.resolve({ entryId: 'owned-trash' }) });
      assert.equal(response.status, 409); assert.equal((await response.json()).code, 'FILE_OPERATION_UNDO_DISABLED');
    });
    assert(connections > 0, 'The SQL claim controls must actually access PGlite.');
    for (const [filename, hash] of pins) assert.equal(createHash('sha256').update(await readFile(filename)).digest('hex'), hash, 'A product source changed during this test.');
    completed = true;
  } finally { clearTimeout(watchdog); await pg.close(); }
  assert.equal(completed, true);
  console.log(`Workspace file Undo disabled: ${families} export/queue/real embedded SQL claim groups passed; no current Auth, PG18, FS Delete or UI acceptance claimed.`);
}
void main().catch(error => { console.error('Undo-disabled boundary failed:', error); process.exitCode = 1; });
