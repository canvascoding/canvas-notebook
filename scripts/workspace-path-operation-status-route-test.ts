import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import type { SqlConnection } from '../app/lib/db';
import { WORKSPACE_OPERATION_REVIEW_STATEMENTS } from '../app/lib/db/workspace-operation-review-migration';
import { WorkspaceOperationBatchError, WorkspaceOperationBatchStore,
  workspaceOperationBatchAuthorityUserId, type WorkspaceOperationBatchRecord } from '../app/lib/files/workspace-operation-batch-store';
import type { WorkspaceOperationBatchPlan, WorkspaceOperationBatchScope,
  WorkspaceOperationBatchExecutionResult } from '../app/lib/files/workspace-operation-batch-contract';
import type { WorkspaceOperationBatchExecutionPublic } from '../app/lib/files/workspace-operation-batch-public';
import type * as BatchService from '../app/lib/files/workspace-operation-batch-service';
import type * as ResponseService from '../app/lib/files/workspace-path-operation-response';
import type * as Route from '../app/api/files/operations/batches/[batchId]/route';
import type { WorkspacePathOperationProblemInput } from '../app/lib/files/workspace-path-operation-problems';
import { workspacePathOperationPublicIssues } from '../app/lib/files/workspace-path-operation-public';

const requireNative = createRequire(path.resolve('package.json'));

async function compile<T>(file: string, mocks: Record<string, unknown>): Promise<T> {
  const source = ts.transpileModule(await fs.readFile(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const compiled = { exports: {} };
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === 'server-only') return {};
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.startsWith('node:')) return requireNative(name);
    throw new Error(`Unexpected dependency in ${file}: ${name}`);
  }, compiled, compiled.exports);
  return compiled.exports as T;
}

async function main(): Promise<void> {
  const pg = new PGlite();
  const connect = async (): Promise<SqlConnection> => ({
    get: async (sql, params = []) => (await pg.query(sql, params)).rows[0],
    all: async (sql, params = []) => (await pg.query(sql, params)).rows,
    run: async (sql, params = []) => pg.query(sql, params), close: () => undefined,
  });
  class FixtureStore extends WorkspaceOperationBatchStore { constructor() { super(connect); } }
  const store = new FixtureStore();
  const batchId = 'direct_status_route_1234567890';
  const planId = 'a'.repeat(64);
  const workspace: WorkspaceOperationBatchScope['workspace'] = {
    workspaceId: 'operation-workspace', rootPath: '/private/operation-route', workspaceType: 'personal',
    organizationId: null, ownerUserId: 'initiator', status: 'active', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true,
      canManageWorkspace: false, canCreatePublicLinks: false },
  };
  const plan: WorkspaceOperationBatchPlan = {
    version: 1, workspaceId: workspace.workspaceId, planId, readiness: 'ready',
    actions: [{ reviewId: 'direct-status-action', kind: 'move', selections: [{ sourcePath: 'old.bin', destinationPath: 'new.bin' }] }],
    pathSteps: [{ reviewId: 'direct-status-action', kind: 'move', sourcePath: 'old.bin', destinationPath: 'new.bin' }],
    pathMappings: [], deletedPaths: [], linkEdits: [], originalDocuments: [], previewContents: [], expectedPathState: [],
    coverage: { complete: true, omittedSources: [], unresolvedLinks: [] },
    linkAssessment: { version: 1, complete: true, warnings: [], blockers: [] }, issues: [], linkPlan: {} as never,
  };
  let authenticated = true;
  let userId = 'initiator';
  let canRead = true;
  let canWrite = true;
  let canDelete = true;
  let canRunAgent = true;
  let agentSessionAvailable = true;
  let agentSessionReads = 0;
  let revokedOnRefresh = false;
  let changedRootOnRefresh = false;
  let workspaceStatus: 'active' | 'archived' = 'active';
  let foreignScope = false;
  let limited = false;
  let authorityReads = 0;
  let journalAvailable = true;
  let publicProofAvailable = true;
  let undoAvailable = true;
  let undoChecks = 0;
  let undoCapabilityChecks = 0;
  let lockDepth = 0;
  const enqueues: Array<Parameters<typeof BatchService.enqueueWorkspaceOperationBatch>[0]> = [];
  const problems: WorkspacePathOperationProblemInput[] = [];
  const permissions: Array<{ workspaceId: string; requested: string | string[]; userId: string }> = [];
  const jsonError = (error: string, status: number, details: object = {}) =>
    Response.json({ success: false, error, ...details }, { status });
  const errors = { WorkspaceOperationBatchError, WorkspaceOperationBatchStore: FixtureStore, workspaceOperationBatchAuthorityUserId };
  const assertUndoAvailable = async (input: { batchId: string; scope: WorkspaceOperationBatchScope }) => {
    if (lockDepth) undoChecks += 1; else undoCapabilityChecks += 1;
    assert.equal(input.batchId, batchId); assert.equal(input.scope.workspace.workspaceId, workspace.workspaceId);
    if (!undoAvailable) throw new Error('Newer work prevents Undo');
  };
  const execution: WorkspaceOperationBatchExecutionResult = {
    status: 'applied', trashEntryIds: [], completedActions: 1, totalActions: 1, errorCode: null,
    stepResults: [{ key: 'path:0', phase: 'path', state: 'applied', path: 'old.bin',
      destinationPath: 'new.bin', mutationId: 'actual-filesystem-receipt' }],
  };
  const publicExecution = async (input: { actionMode: 'apply' | 'undo' }): Promise<WorkspaceOperationBatchExecutionPublic> => ({
    mode: input.actionMode, receiptStatus: publicProofAvailable ? 'available' : 'unavailable',
    finalization: publicProofAvailable ? 'complete' : 'pending',
    steps: [{ key: 'path:0', phase: 'path', kind: 'move', state: 'applied',
      path: input.actionMode === 'undo' ? 'new.bin' : 'old.bin', destinationPath: input.actionMode === 'undo' ? 'old.bin' : 'new.bin' }],
  });
  const settle = async (status: WorkspaceOperationBatchRecord['status'], mode: 'apply' | 'undo' = 'apply') => {
    await pg.query(`UPDATE workspace_file_operation_batches SET status=$2,action_mode=$3,completed_actions=$4,
      phase=$5,error_code=$6,lease_owner=NULL,lease_expires_at=NULL WHERE batch_id=$1`,
    [batchId, status, mode, ['applied', 'undone'].includes(status) ? 1 : 0,
      ['applied', 'undone'].includes(status) ? 'complete' : 'preparing', status === 'failed' ? 'LINK_WRITE_STALE' : null]);
  };
  try {
    for (const statement of WORKSPACE_OPERATION_REVIEW_STATEMENTS) await pg.exec(statement);
    await store.createDirect({ batchId, plan, authorization: { mode: 'direct', actorUserId: 'initiator',
      actorId: 'canvas-agent', actorDisplayName: 'Agent', actorType: 'agent', actorSessionId: 'original-agent-session',
      requestHash: 'c'.repeat(64) } });
    const service = await compile<typeof BatchService>('app/lib/files/workspace-operation-batch-service.ts', {
      '@/app/lib/document-review-availability': { readDocumentReviewAvailability: () => ({ documentReviewEnabled: false, updatedAt: null }) },
      '@/app/lib/db': { openDb: async () => { throw new Error('No unowned database access'); } },
      './workspace-operation-batch-store': errors,
      './workspace-mutation-lock': { withWorkspaceMutationLock: async (_id: string, action: () => Promise<unknown>) => {
        lockDepth += 1;
        try { return await action(); } finally { lockDepth -= 1; }
      } },
      './workspace-operation-batch-plan': { workspaceOperationBatchPublicPreview: () => ({ planId }) },
      './workspace-operation-batch-executor': {
        getWorkspaceOperationBatchExecutionPublic: publicExecution,
        assertWorkspaceOperationBatchUndoAvailable: assertUndoAvailable,
      },
      './workspace-operation-review-service': {}, './workspace-operation-batch-approval-fence': {},
    });
    const responseService = await compile<typeof ResponseService>('app/lib/files/workspace-path-operation-response.ts', {
      './workspace-path-operation-public': { workspacePathOperationPublicIssues },
      '@/app/lib/filesystem/workspace-trash': { listWorkspaceTrashEntries: async () => [] },
      './workspace-operation-batch-store': errors,
      './workspace-operation-batch-executor': { getWorkspaceOperationBatchExecutionPublic: publicExecution,
        getWorkspaceOperationBatchExecution: async () => journalAvailable ? execution : null },
    });
    const route = await compile<typeof Route>('app/api/files/operations/batches/[batchId]/route.ts', {
      '@/app/lib/auth': { auth: { api: { getSession: async () => authenticated ? { user: { id: userId, name: 'Initiator' } } : null } } },
      '@/app/lib/files/workspace-operation-batch-store': errors,
      '@/app/lib/files/workspace-path-operation-response': responseService,
      '@/app/lib/files/workspace-path-operation-problems': { recordWorkspacePathOperationProblem: async (input: WorkspacePathOperationProblemInput) => { problems.push(input); } },
      '@/app/lib/files/workspace-operation-batch-executor': { assertWorkspaceOperationBatchUndoAvailable: assertUndoAvailable },
      '@/app/lib/db': { openDb: connect },
      '@/app/lib/pi/session-workspace-context': { readStoredAgentWorkspaceOnConnection: async (_db: unknown,
        input: { userId: string; agentId: string; sessionId: string; workspaceId: string; permissions: string[] }) => {
        agentSessionReads += 1;
        assert.equal(input.userId, 'initiator'); assert.equal(input.agentId, 'canvas-agent');
        assert.equal(input.sessionId, 'original-agent-session'); assert.equal(input.workspaceId, workspace.workspaceId);
        assert.deepEqual(input.permissions, ['canRead', 'canRunAgent', 'canWrite', 'canDelete']);
        if (!agentSessionAvailable) throw new Error('Originating session revoked');
        return workspace;
      } },
      '@/app/lib/files/workspace-operation-batch-service': { enqueueWorkspaceOperationBatch: async (input: (typeof enqueues)[number]) => {
        enqueues.push(input); return service.enqueueWorkspaceOperationBatch(input);
      } },
      '@/app/lib/api/route-helpers': {
        applyRateLimit: () => limited ? jsonError('Too many requests', 429) : null, jsonError,
        jsonSuccess: (body: object, init?: ResponseInit) => Response.json({ success: true, ...body }, init),
        jsonServerError: (_prefix: string, error: unknown) => jsonError(String(error), 500),
      },
      '@/app/lib/workspaces/request': {
        workspaceFileOptions: (current: typeof workspace) => ({ workspace: current }),
        requireSessionWorkspace: async (session: { user: { id: string } }, input: { workspaceId: string; permissions: string | string[] }) => {
          authorityReads += 1;
          permissions.push({ workspaceId: input.workspaceId, requested: input.permissions, userId: session.user.id });
          assert.equal(input.workspaceId, workspace.workspaceId, 'authority is scoped to the stored batch, not a request header');
          if (!canRead || Array.isArray(input.permissions) && (!canWrite || !canDelete)
            || revokedOnRefresh && authorityReads > 1) return { response: jsonError('Forbidden', 403) };
          return { workspace: { ...workspace, status: workspaceStatus,
            workspaceId: foreignScope ? 'foreign-workspace' : workspace.workspaceId,
            rootPath: changedRootOnRefresh && authorityReads > 1 ? '/changed/root' : workspace.rootPath,
            permissions: { ...workspace.permissions, canRead, canWrite, canDelete, canRunAgent } } };
        },
      },
    });
    const invoke = async (method: 'GET' | 'POST', body: unknown = { action: 'resume', planId }, id = batchId) => {
      authorityReads = 0;
      const request = new NextRequest(`http://localhost/api/files/operations/batches/${id}`, {
        method, headers: { 'Content-Type': 'application/json', 'x-workspace-id': 'foreign-workspace' },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      });
      const response = await route[method](request, { params: Promise.resolve({ batchId: id }) });
      assert.ok(response, 'every route path returns a response');
      return response;
    };
    authenticated = false;
    for (const method of ['GET', 'POST'] as const) assert.equal((await invoke(method)).status, 401);
    authenticated = true; limited = true;
    for (const method of ['GET', 'POST'] as const) assert.equal((await invoke(method)).status, 429);
    limited = false;
    for (const method of ['GET', 'POST'] as const) {
      assert.equal((await invoke(method, {}, 'unknown_batch_1234567890')).status, 404);
      assert.equal(authorityReads, 0, 'unknown jobs never resolve an unrelated workspace');
    }
    canRead = false;
    for (const method of ['GET', 'POST'] as const) assert.equal((await invoke(method)).status, 403);
    canRead = true; canWrite = false; canDelete = false;
    const pending = await invoke('GET');
    assert.equal(pending.status, 200); assert.equal(pending.headers.get('Cache-Control'), 'no-store');
    const pendingBody = await pending.json();
    assert.equal(pendingBody.operation.status, 'queued');
    assert.deepEqual(Object.keys(pendingBody).sort(), ['operation', 'recovery', 'success']);
    assert.deepEqual(pendingBody.recovery, { canResume: false, canUndo: false });
    assert.equal((await invoke('POST')).status, 403, 'read authority does not authorize recovery');
    canWrite = true;
    assert.equal((await invoke('POST')).status, 403, 'delete authority is separately required');
    canDelete = true; canWrite = false;
    assert.equal((await invoke('POST')).status, 403, 'write authority is separately required');
    canWrite = true;
    for (const status of ['applying', 'blocked', 'needs_review', 'needs_recovery', 'failed'] as const) {
      await settle(status);
      const body = await (await invoke('GET')).json();
      assert.equal(body.operation.status, status);
      assert.deepEqual(Object.keys(body).sort(), ['operation', 'recovery', 'success']);
      assert.deepEqual(body.recovery, { canResume: ['needs_recovery', 'failed'].includes(status), canUndo: false });
    }
    const originalSessionReads = agentSessionReads;
    canRunAgent = false;
    assert.equal((await (await invoke('GET')).json()).recovery.canResume, false);
    assert.equal(agentSessionReads, originalSessionReads, 'revoked agent permission disables Resume before opening the original session');
    canRunAgent = true; agentSessionAvailable = false;
    assert.equal((await (await invoke('GET')).json()).recovery.canResume, false, 'revoked originating session cannot advertise an agent Resume');
    await settle('failed', 'undo');
    assert.equal((await (await invoke('GET')).json()).recovery.canResume, true, 'human Undo recovery does not depend on the old agent session');
    agentSessionAvailable = true;
    await settle('applied');
    const appliedBody = await (await invoke('GET')).json();
    assert.equal(appliedBody.operation.batchId, batchId);
    assert.equal(appliedBody.mutation.operationId, 'actual-filesystem-receipt');
    assert.equal(appliedBody.linkStatus, 'complete');
    assert.deepEqual(appliedBody.recovery, { canResume: false, canUndo: true });
    undoAvailable = false;
    assert.equal((await (await invoke('GET')).json()).recovery.canUndo, false, 'SQL applied alone never proves safe Undo');
    undoAvailable = true;
    assert.equal(JSON.stringify(appliedBody).includes('original-agent-session'), false);
    for (const missing of ['public', 'raw'] as const) {
      publicProofAvailable = missing !== 'public'; journalAvailable = missing !== 'raw';
      const response = await invoke('GET');
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.code, 'BATCH_JOURNAL_UNAVAILABLE'); assert.equal(body.mutation, undefined);
      assert.equal((problems.at(-1)!.error as { code: string }).code, 'BATCH_JOURNAL_UNAVAILABLE');
      assert.equal(problems.at(-1)!.workspace.workspaceId, workspace.workspaceId);
    }
    publicProofAvailable = true; journalAvailable = true;
    await settle('undone', 'undo');
    const undoneBody = await (await invoke('GET')).json();
    assert.equal(undoneBody.operation.status, 'undone'); assert.equal(undoneBody.mutation, undefined);
    publicProofAvailable = false;
    assert.equal((await invoke('GET')).status, 409, 'undone SQL status also requires complete inverse proof');
    publicProofAvailable = true; foreignScope = true;
    assert.equal((await invoke('GET')).status, 403);
    foreignScope = false; workspaceStatus = 'archived';
    assert.equal((await invoke('GET')).status, 403);
    workspaceStatus = 'active'; await settle('failed');
    const beforeValidation = enqueues.length;
    for (const invalid of [null, [], {}, { action: 'accept', planId }, { action: 'undo' },
      { action: 'resume', planId: 'invalid' }, { action: 'resume', planId: 'A'.repeat(64) }]) {
      assert.equal((await invoke('POST', invalid)).status, 422);
    }
    assert.equal(enqueues.length, beforeValidation, 'invalid requests never reach the durable queue');
    const stale = await invoke('POST', { action: 'resume', planId: 'b'.repeat(64) });
    assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'PREVIEW_STALE');
    assert.equal((await store.get(batchId))?.status, 'failed');
    userId = 'another-member';
    assert.deepEqual((await (await invoke('GET')).json()).recovery, { canResume: false, canUndo: false });
    const problemsBeforeDenied = problems.length;
    for (const action of ['resume', 'undo']) {
      const denied = await invoke('POST', { action, planId });
      assert.equal(denied.status, 403); assert.equal((await denied.json()).code, 'BATCH_DIRECT_AUTHORIZATION_REQUIRED');
    }
    assert.equal(problems.length, problemsBeforeDenied, 'a different actor never creates a foreign problem through rejected recovery');
    userId = 'initiator'; revokedOnRefresh = true;
    assert.equal((await invoke('POST')).status, 403);
    assert.equal((await store.get(batchId))?.status, 'failed', 'revocation is rechecked under the recovery lock');
    revokedOnRefresh = false; changedRootOnRefresh = true;
    assert.equal((await invoke('POST')).status, 403);
    assert.equal((await store.get(batchId))?.status, 'failed');
    changedRootOnRefresh = false;
    const resumed = await invoke('POST');
    assert.equal(resumed.status, 202); assert.equal(resumed.headers.get('Cache-Control'), 'no-store');
    const resumedBody = await resumed.json();
    assert.equal(resumedBody.operation.batchId, batchId); assert.equal(resumedBody.operation.planId, planId);
    assert.equal(resumedBody.operation.status, 'queued'); assert.equal(resumedBody.mutation, undefined);
    const resumedRecord = (await store.get(batchId))!;
    assert.equal(resumedRecord.status, 'queued'); assert.equal(resumedRecord.actionMode, 'apply');
    assert.equal(resumedRecord.reviewerUserId, null); assert.deepEqual(resumedRecord.reviewIds, []);
    assert.equal(resumedRecord.authorization.mode, 'direct');
    const last = enqueues.at(-1)!;
    assert.equal(last.userId, 'initiator'); assert.equal(last.planId, planId); assert.equal(last.action, 'resume');
    assert.equal(last.scope.workspace.workspaceId, workspace.workspaceId);
    await settle('applied'); undoAvailable = false;
    const refusedUndo = await invoke('POST', { action: 'undo', planId });
    assert.equal(refusedUndo.status, 409); assert.equal((await refusedUndo.json()).code, 'BATCH_UNDO_CONFLICT');
    assert.equal((await store.get(batchId))?.status, 'applied');
    undoAvailable = true;
    const queuedUndo = await invoke('POST', { action: 'undo', planId });
    const undoBody = await queuedUndo.json();
    assert.equal(queuedUndo.status, 202); assert.equal(undoBody.operation.status, 'queued');
    assert.deepEqual(Object.keys(undoBody).sort(), ['operation', 'success']);
    const undoRecord = (await store.get(batchId))!;
    assert.equal(undoRecord.actionMode, 'undo'); assert.equal(undoRecord.status, 'queued');
    assert.equal(undoRecord.reviewerUserId, null); assert.equal(undoRecord.completedActions, 0);
    assert.equal(undoChecks, 2, 'both Undo requests inspect the genuine operation before queueing');
    assert.ok(undoCapabilityChecks >= 2);
    assert.ok(permissions.every((entry) => entry.workspaceId === workspace.workspaceId));
    assert.ok(permissions.some((entry) => entry.requested === 'canRead'));
    assert.ok(permissions.some((entry) => JSON.stringify(entry.requested) === JSON.stringify(['canRead', 'canWrite', 'canDelete'])));
    assert.equal(Number((await pg.query<{ count: string }>('SELECT count(*)::text AS count FROM workspace_file_operation_batches')).rows[0]!.count), 1,
      'recovery requeues the original batch without manufacturing another successful operation');
    await pg.query(`UPDATE workspace_file_operation_batches SET authorization_json=$2,reviewer_user_id=$3 WHERE batch_id=$1`,
      [batchId, JSON.stringify({ mode: 'review' }), 'original-reviewer']);
    await settle('failed');
    assert.equal((await (await invoke('GET')).json()).recovery.canResume, false, 'review recovery belongs to its original reviewer');
    userId = 'original-reviewer';
    assert.equal((await (await invoke('GET')).json()).recovery.canResume, true);
    await settle('applied'); userId = 'another-writer';
    assert.equal((await (await invoke('GET')).json()).recovery.canUndo, true, 'authorized writers may safely Undo a reviewed batch');
    console.log('workspace path status/recovery route: scoped authority, exact plan, actual receipts, genuine resume/Undo queue and refreshed permissions passed');
  } finally { await pg.close(); }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
