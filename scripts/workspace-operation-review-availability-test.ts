import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import { WORKSPACE_OPERATION_REVIEW_STATEMENTS } from '../app/lib/db/workspace-operation-review-migration';
import type { SqlConnection } from '../app/lib/db';
import { buildWorkspaceOperationBatchPlan as buildBatchPlan } from '../app/lib/files/workspace-operation-batch-plan';
import * as fileOperationPreview from '../app/lib/markdown/workspace-file-operation-preview';
import { WorkspaceOperationBatchStore } from '../app/lib/files/workspace-operation-batch-store';
import { WorkspaceOperationCheckStore } from '../app/lib/files/workspace-operation-check-store';
import { createWorkspaceOperationBatchWorker } from '../app/lib/files/workspace-operation-batch-worker';
import type { WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';
import type * as ReviewService from '../app/lib/files/workspace-operation-review-service';
import type * as BatchService from '../app/lib/files/workspace-operation-batch-service';
import type * as DeleteService from '../app/lib/files/workspace-operation-delete-review';
import type * as CheckService from '../app/lib/files/workspace-operation-check-service';

const buildWorkspaceOperationBatchPlan = (input: Parameters<typeof buildBatchPlan>[0]) =>
  buildBatchPlan(input, { buildSnapshot: fileOperationPreview.buildWorkspacePlannerSnapshot });
const filePreviewModule = { ...fileOperationPreview,
  buildWorkspaceFileOperationPreview: (input: Parameters<typeof fileOperationPreview.buildWorkspaceFileOperationPreview>[0]) =>
    fileOperationPreview.buildWorkspaceFileOperationPreview(input, { buildSnapshot: fileOperationPreview.buildWorkspacePlannerSnapshot }) };

async function load<T extends object>(filename: string, mocks: Record<string, unknown>): Promise<T> {
  const absolute = path.resolve(filename);
  const source = ts.transpileModule(await fs.readFile(absolute, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const native = createRequire(absolute);
  const loaded = { exports: {} as T };
  new Function('require', 'module', 'exports', source)((name: string) => name in mocks ? mocks[name] : native(name), loaded, loaded.exports);
  return loaded.exports;
}

async function main() {
  const postgres = new PGlite();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-review-availability-'));
  let enabled = true;
  let disableAfterPlan = false;
  let disableDuringApproval = false;
  let disableDuringCheckRead = false;
  let approvalFences = 0;
  let lockDepth = 0;
  const connect = async (): Promise<SqlConnection> => ({
    get: async (sql, params = []) => (await postgres.query(sql, params)).rows[0],
    all: async (sql, params = []) => {
      const result = (await postgres.query(sql, params)).rows;
      if (disableDuringCheckRead && sql.includes('SELECT review_id,source_workspace_id')) enabled = false;
      return result;
    },
    run: async (sql, params = []) => postgres.query(sql, params), close: () => undefined,
  });
  const scope: WorkspaceOperationBatchScope = { workspace: { workspaceId: 'availability-workspace', workspaceType: 'personal',
    rootPath: root, rootRelativePath: 'workspace', ownerUserId: 'reviewer', organizationId: null, status: 'active', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManageWorkspace: true, canCreatePublicLinks: false } }, fileOptions: {} };
  scope.fileOptions = { workspace: scope.workspace };
  const store = new WorkspaceOperationBatchStore(connect);
  const checkStore = new WorkspaceOperationCheckStore(connect);
  const lock = async <T>(_id: string, action: () => Promise<T>) => { lockDepth += 1; try { return await action(); } finally { lockDepth -= 1; } };
  const planModule = { buildWorkspaceOperationBatchPlan: async (input: Parameters<typeof buildWorkspaceOperationBatchPlan>[0]) => {
    const plan = await buildWorkspaceOperationBatchPlan(input);
    if (disableAfterPlan) enabled = false;
    return plan;
  }, workspaceOperationBatchPublicPreview: (await import('../app/lib/files/workspace-operation-batch-plan')).workspaceOperationBatchPublicPreview };
  const mocks: Record<string, unknown> = {
    'server-only': {}, '@/app/lib/db': { openDb: connect },
    '@/app/lib/markdown/workspace-file-operation-preview': filePreviewModule,
    '@/app/lib/document-review-availability': { readDocumentReviewAvailability: () => ({ documentReviewEnabled: enabled, updatedAt: null }) },
    '@/app/lib/files/workspace-mutation-lock': { withWorkspaceMutationLock: lock }, './workspace-mutation-lock': { withWorkspaceMutationLock: lock },
    './workspace-operation-batch-plan': planModule,
    './workspace-operation-batch-executor': { getWorkspaceOperationBatchTransitionProofs: async () => [],
      getWorkspaceOperationBatchExecutionPublic: async () => null, assertWorkspaceOperationBatchUndoAvailable: async () => undefined },
    './workspace-operation-batch-approval-fence': { assertWorkspaceOperationBatchApprovalCurrent: async () => {
      assert.equal(lockDepth, 1, 'initial approval fences run inside the workspace mutation lock');
      approvalFences += 1;
      if (disableDuringApproval) enabled = false;
    } },
    './workspace-operation-batch-store': { ...(await import('../app/lib/files/workspace-operation-batch-store')),
      WorkspaceOperationBatchStore: class extends WorkspaceOperationBatchStore { constructor() { super(connect); } } },
    './workspace-operation-check-store': { WorkspaceOperationCheckStore: class extends WorkspaceOperationCheckStore { constructor() { super(connect); } } },
  };
  try {
    for (const statement of WORKSPACE_OPERATION_REVIEW_STATEMENTS) await postgres.exec(statement);
    const reviews = await load<typeof ReviewService>('app/lib/files/workspace-operation-review-service.ts', mocks);
    mocks['./workspace-operation-review-service'] = reviews;
    const batches = await load<typeof BatchService>('app/lib/files/workspace-operation-batch-service.ts', mocks);
    mocks['./workspace-operation-batch-service'] = batches;
    const deletion = await load<typeof DeleteService>('app/lib/files/workspace-operation-delete-review.ts', mocks);
    const checks = await load<typeof CheckService>('app/lib/files/workspace-operation-check-service.ts', mocks);
    await fs.writeFile(path.join(root, 'source.md'), '# Source\n');
    await fs.writeFile(path.join(root, 'index.md'), '[Source](source.md)\n');
    const reviewId = 'review-availability-123456';
    await postgres.query(`INSERT INTO workspace_file_operation_reviews
      (review_id,plan_id,request_hash,request_json,preview_json,source_workspace_id,destination_workspace_id,
       actor_user_id,actor_id,actor_display_name,status,reason_codes_json,created_at,updated_at)
      VALUES($1,$2,$2,$3,$4,$5,$5,'reviewer','agent','Agent','pending','[]',1,1)`,
    [reviewId, 'a'.repeat(64), JSON.stringify({ kind: 'move', selections: [{ sourcePath: 'source.md', destinationPath: 'moved.md' }] }),
      JSON.stringify({ kind: 'move', pathMappings: [], potentialBrokenLinks: [] }), scope.workspace.workspaceId]);
    const rowBytes = async () => JSON.stringify((await postgres.query('SELECT * FROM workspace_file_operation_reviews WHERE review_id=$1', [reviewId])).rows[0]);
    const savedBytes = await rowBytes();
    const previewInput = { scope, reviewIds: [reviewId] };
    const checkInput = { ...previewInput, requesterUserId: 'reviewer' };
    enabled = false;
    await assert.rejects(batches.createWorkspaceOperationBatchReview(previewInput), { code: 'DOCUMENT_REVIEW_DISABLED', status: 409 });
    await assert.rejects(checks.enqueueWorkspaceOperationCheck(checkInput), { code: 'DOCUMENT_REVIEW_DISABLED', status: 409 });
    assert.equal(await rowBytes(), savedBytes);
    assert.equal((await postgres.query('SELECT * FROM workspace_file_operation_batches')).rows.length, 0);
    assert.equal((await postgres.query('SELECT * FROM workspace_file_operation_checks')).rows.length, 0);
    enabled = true; disableAfterPlan = true;
    await assert.rejects(batches.createWorkspaceOperationBatchReview(previewInput), { code: 'DOCUMENT_REVIEW_DISABLED' });
    assert.equal((await postgres.query('SELECT * FROM workspace_file_operation_batches')).rows.length, 0);
    assert.equal(await rowBytes(), savedBytes);
    disableAfterPlan = false; enabled = true;
    const preview = await batches.createWorkspaceOperationBatchReview(previewInput);
    assert.equal(preview.status, 'preview');
    const approval = { scope, batchId: preview.batchId, planId: preview.planId, userId: 'reviewer', displayName: 'Reviewer' };
    enabled = false;
    await assert.rejects(batches.enqueueWorkspaceOperationBatch(approval), { code: 'DOCUMENT_REVIEW_DISABLED' });
    assert.equal((await store.get(preview.batchId))?.status, 'preview');
    assert.equal(await rowBytes(), savedBytes);
    enabled = true; disableDuringApproval = true;
    await assert.rejects(batches.enqueueWorkspaceOperationBatch(approval), { code: 'DOCUMENT_REVIEW_DISABLED' });
    assert.equal((await store.get(preview.batchId))?.status, 'preview');
    assert.equal(await rowBytes(), savedBytes);
    disableDuringApproval = false; enabled = true;
    const queued = await batches.enqueueWorkspaceOperationBatch(approval);
    assert.equal(queued.status, 'queued');
    enabled = false;
    assert.equal((await batches.enqueueWorkspaceOperationBatch(approval)).status, 'queued', 'accepted retries remain independent of the experiment');
    assert.equal((await batches.getWorkspaceOperationBatchReview(preview.batchId, scope))?.status, 'queued');
    const fences = approvalFences;
    let executions = 0;
    const executionWorker = createWorkspaceOperationBatchWorker({ store, lock, resolveScope: async () => scope,
      buildPlan: buildWorkspaceOperationBatchPlan, hasExecution: async () => false, mutationEvidence: async () => 'started',
      dependentReviews: async () => undefined, projectFileViews: () => undefined,
      execute: async ({ plan }) => {
        executions += 1;
        if (executions === 1) return { status: 'failed', completedActions: 0, totalActions: plan.pathSteps.length + plan.previewContents.length,
          trashEntryIds: [], errorCode: 'RETRY_REQUIRED' };
        await fs.rename(path.join(root, 'source.md'), path.join(root, 'moved.md'));
        for (const document of plan.previewContents) await fs.writeFile(path.join(root, document.path), document.content);
        return { status: 'applied', completedActions: plan.pathSteps.length + plan.previewContents.length,
          totalActions: plan.pathSteps.length + plan.previewContents.length, trashEntryIds: [], errorCode: null };
      },
      undo: async () => {
        await fs.rename(path.join(root, 'moved.md'), path.join(root, 'source.md'));
        await fs.writeFile(path.join(root, 'index.md'), '[Source](source.md)\n');
        return { status: 'applied', completedActions: 2, totalActions: 2, trashEntryIds: [], errorCode: null };
      } });
    await executionWorker.tick();
    assert.equal((await store.get(preview.batchId))?.status, 'failed');
    assert.equal((await batches.enqueueWorkspaceOperationBatch({ ...approval, action: 'resume' })).status, 'queued');
    await executionWorker.tick();
    assert.equal((await store.get(preview.batchId))?.status, 'applied');
    assert.equal(await fs.readFile(path.join(root, 'index.md'), 'utf8'), '[Source](moved.md)\n');
    assert.equal((await batches.enqueueWorkspaceOperationBatch({ ...approval, action: 'undo' })).status, 'queued');
    await executionWorker.tick();
    assert.equal((await store.get(preview.batchId))?.status, 'undone');
    assert.equal(await fs.readFile(path.join(root, 'index.md'), 'utf8'), '[Source](source.md)\n');
    assert.equal(await fs.readFile(path.join(root, 'source.md'), 'utf8'), '# Source\n');
    assert.equal(approvalFences, fences, 'resume and Undo do not acquire a new experimental approval');

    const manualInput = { scope, paths: ['source.md'], userId: 'reviewer', displayName: 'Reviewer', idempotencyKey: 'manual-delete' };
    await assert.rejects(deletion.reviewWorkspaceDeletionIfRequired(manualInput), { code: 'DOCUMENT_REVIEW_DISABLED' });
    enabled = true;
    const manual = await deletion.reviewWorkspaceDeletionIfRequired(manualInput);
    assert.equal(manual?.reviewRequired.status, 'pending');
    enabled = false;
    await fs.rename(path.join(root, 'source.md'), path.join(root, 'external-move.md'));
    assert.deepEqual(await deletion.getExistingWorkspaceDeletionReview(manualInput), manual, 'lookup never requires the original source to exist');
    assert.deepEqual(await deletion.reviewWorkspaceDeletionIfRequired(manualInput), manual, 'OFF retains the original immutable manual review');
    await assert.rejects(deletion.getExistingWorkspaceDeletionReview({ ...manualInput, paths: ['external-move.md'] }), { code: 'REVIEW_IDEMPOTENCY_CONFLICT' });
    await postgres.query(`UPDATE workspace_file_operation_reviews SET status='queued' WHERE review_id=$1`, [manual!.reviewRequired.reviewId]);
    assert.equal((await deletion.getExistingWorkspaceDeletionReview(manualInput))?.reviewRequired.status, 'queued', 'known review status is never fabricated as pending');
    await fs.rename(path.join(root, 'external-move.md'), path.join(root, 'source.md'));
    enabled = true; disableAfterPlan = true;
    const before = (await postgres.query('SELECT * FROM workspace_file_operation_reviews')).rows.length;
    await assert.rejects(deletion.reviewWorkspaceDeletionIfRequired({ ...manualInput, idempotencyKey: 'new-delete' }), { code: 'DOCUMENT_REVIEW_DISABLED' });
    assert.equal((await postgres.query('SELECT * FROM workspace_file_operation_reviews')).rows.length, before);
    assert.equal(await fs.readFile(path.join(root, 'source.md'), 'utf8'), '# Source\n');
    disableAfterPlan = false;
    // New checks need the feature even after their authorization rows were read.
    await postgres.query(`UPDATE workspace_file_operation_reviews SET status='pending',batch_id=NULL WHERE review_id=$1`, [reviewId]);
    enabled = true; disableDuringCheckRead = true;
    await assert.rejects(checks.enqueueWorkspaceOperationCheck(checkInput), { code: 'DOCUMENT_REVIEW_DISABLED' });
    assert.equal((await postgres.query('SELECT * FROM workspace_file_operation_checks')).rows.length, 0);
    disableDuringCheckRead = false; enabled = true;
    const check = await checks.enqueueWorkspaceOperationCheck(checkInput);
    assert.equal((await checkStore.get(check.checkId))?.status, 'queued');
    enabled = false;
    assert.equal((await checks.getWorkspaceOperationCheckResult(check.checkId, scope)).check.status, 'queued', 'authenticated check reads remain available OFF');
    console.log('workspace-operation-review-availability-test: ok');
  } finally { await postgres.close(); await fs.rm(root, { recursive: true, force: true }); }
}

void main();
