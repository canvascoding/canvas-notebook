import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { SqlConnection } from '../app/lib/db';
import { WORKSPACE_OPERATION_REVIEW_STATEMENTS } from '../app/lib/db/workspace-operation-review-migration';
import { WorkspaceOperationCheckStore } from '../app/lib/files/workspace-operation-check-store';
import { createWorkspaceOperationCheckWorker } from '../app/lib/files/workspace-operation-check-worker';
import { createWorkspaceOperationBatchWorker } from '../app/lib/files/workspace-operation-batch-worker';
import { WorkspaceOperationBatchStore, WorkspaceOperationBatchError } from '../app/lib/files/workspace-operation-batch-store';
import { buildWorkspaceOperationBatchPlan } from '../app/lib/files/workspace-operation-batch-plan';
import { workspaceOperationBatchPublic } from '../app/lib/files/workspace-operation-batch-service';
import type { WorkspaceOperationBatchScope } from '../app/lib/files/workspace-operation-batch-contract';

async function main(): Promise<void> {
  const pg = new PGlite();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-review-check-'));
  let now = 1_000;
  const connect = async (): Promise<SqlConnection> => ({
    get: async (sql, params = []) => (await pg.query(sql, params)).rows[0],
    all: async (sql, params = []) => (await pg.query(sql, params)).rows,
    run: async (sql, params = []) => pg.query(sql, params), close: () => undefined,
  });
  const store = new WorkspaceOperationCheckStore(connect, () => now);
  const batches = new WorkspaceOperationBatchStore(connect, () => now);
  const scope: WorkspaceOperationBatchScope = { workspace: { workspaceId: 'workspace', workspaceType: 'personal',
    rootPath: root, rootRelativePath: 'workspace', ownerUserId: 'reviewer', organizationId: null, status: 'active', legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManageWorkspace: true, canCreatePublicLinks: false } }, fileOptions: {} };
  scope.fileOptions = { workspace: scope.workspace };
  const reviewId = 'review_check_1234567890';
  const otherId = 'review_other_1234567890';
  const queue = (requesterUserId = 'reviewer', reviewIds = [reviewId, otherId]) => {
    now += 1;
    return store.enqueue({ workspaceId: 'workspace', requesterUserId, reviewIds });
  };
  const directLock = async <T>(_id: string, action: () => Promise<T>) => action();
  try {
    for (const statement of WORKSPACE_OPERATION_REVIEW_STATEMENTS) await pg.exec(statement);
    await fs.writeFile(path.join(root, 'source.md'), '# Source\n');
    await fs.writeFile(path.join(root, 'index.md'), '[Source](source.md)\n');
    await pg.query(`INSERT INTO workspace_file_operation_reviews
      (review_id,plan_id,request_hash,request_json,preview_json,source_workspace_id,destination_workspace_id,
       actor_user_id,actor_id,actor_display_name,status,reason_codes_json,created_at,updated_at)
      VALUES ($1,$2,$2,$3,'{}','workspace','workspace','reviewer','agent','Agent','pending','[]',1,1)`,
    [reviewId, 'a'.repeat(64), JSON.stringify({ kind: 'move', selections: [{ sourcePath: 'source.md', destinationPath: 'moved.md' }] })]);
    const first = await queue();
    const repeats = await Promise.all([queue('reviewer', [otherId, reviewId]), queue()]);
    assert.ok(repeats.every((job) => job.checkId === first.checkId), 'concurrent equivalent selections share one durable job');
    const otherUser = await queue('another-reviewer');
    assert.notEqual(otherUser.checkId, first.checkId, 'a different requester has a separate authority-bound job');
    const originalClaim = await store.claim('original-worker');
    assert.equal(originalClaim?.checkId, first.checkId);
    for (const statement of WORKSPACE_OPERATION_REVIEW_STATEMENTS) await pg.exec(statement);
    assert.equal((await store.get(first.checkId))?.status, 'checking', 'repeated migrations preserve in-flight checks');
    assert.equal(await store.claim('parallel-worker'), null, 'active workspace checks do not overlap');
    now += 90_001;
    const restartedClaim = await store.claim('restarted-worker');
    assert.equal(restartedClaim?.checkId, first.checkId);
    assert.equal(await store.heartbeat(first.checkId, 'original-worker'), false);
    assert.equal(await store.finish(first.checkId, 'original-worker', { status: 'ready', batchId: 'unproven-result' }), false);
    assert.equal(await store.finish(first.checkId, 'restarted-worker', { status: 'ready', batchId: 'saved-result' }), true);
    assert.equal((await store.get(first.checkId))?.batchId, 'saved-result');
    await store.claim('other-worker');
    await store.finish(otherUser.checkId, 'other-worker', { status: 'failed', errorCode: 'CHECK_ACCESS_DENIED' });
    const recheck = await queue('reviewer', [reviewId]);
    assert.notEqual(recheck.checkId, first.checkId, 'terminal results never substitute for a requested new check');
    let previews = 0;
    const worker = createWorkspaceOperationCheckWorker({ store, lock: directLock, resolveScope: async () => scope,
      preview: async ({ reviewIds }) => {
        previews += 1;
        assert.deepEqual(reviewIds, [reviewId]);
        const plan = await buildWorkspaceOperationBatchPlan({ scope, actions: [{ reviewId, kind: 'move',
          selections: [{ sourcePath: 'source.md', destinationPath: 'moved.md' }] }] });
        return workspaceOperationBatchPublic(await batches.create({ batchId: 'batch_check_result_1234567890', plan,
          reviewRefs: [{ reviewId, planId: 'a'.repeat(64), status: 'pending' }] }));
      } });
    assert.equal(await worker.tick(), true);
    const complete = await store.get(recheck.checkId);
    assert.equal(complete?.status, 'ready');
    assert.equal((await batches.get(complete!.batchId!))?.status, 'preview', 'checks persist a reviewable result without approving it');
    const history = (await pg.query<{ status: string; batch_id: string | null; operation_id: string | null }>(
      'SELECT status,batch_id,operation_id FROM workspace_file_operation_reviews WHERE review_id=$1', [reviewId])).rows[0];
    assert.deepEqual(history, { status: 'pending', batch_id: null, operation_id: null }, 'checking never reserves or accepts the original review');
    assert.equal(await fs.readFile(path.join(root, 'source.md'), 'utf8'), '# Source\n');
    assert.equal(await fs.readFile(path.join(root, 'index.md'), 'utf8'), '[Source](source.md)\n');
    await assert.rejects(fs.stat(path.join(root, 'moved.md')), { code: 'ENOENT' });
    const denied = await queue('revoked-user', [reviewId]);
    await createWorkspaceOperationCheckWorker({ store, lock: directLock,
      resolveScope: async () => { throw new Error('CHECK_ACCESS_DENIED'); },
      preview: async () => { previews += 1; throw new Error('must not scan'); } }).tick();
    assert.equal((await store.get(denied.checkId))?.errorCode, 'CHECK_ACCESS_DENIED');
    assert.equal(previews, 1, 'current authority is resolved before any workspace scan');
    const conflict = await queue('reviewer', [reviewId]);
    await createWorkspaceOperationCheckWorker({ store, lock: directLock, resolveScope: async () => scope,
      preview: async () => { throw new WorkspaceOperationBatchError('REVIEW_CONFLICT', 409, 'Review changed.'); } }).tick();
    assert.equal((await store.get(conflict.checkId))?.status, 'failed');
    assert.equal((await store.get(conflict.checkId))?.errorCode, 'REVIEW_CONFLICT');
    const leaseLost = await queue('reviewer', [reviewId]);
    await createWorkspaceOperationCheckWorker({ store, lock: directLock, resolveScope: async () => scope,
      preview: async () => {
        now += 90_001;
        await store.claim('replacement-worker');
        return workspaceOperationBatchPublic((await batches.get(complete!.batchId!))!);
      } }).tick();
    assert.equal((await store.get(leaseLost.checkId))?.status, 'checking', 'lost lease cannot publish an obsolete result');
    assert.equal((await store.get(leaseLost.checkId))?.batchId, null);
    await store.finish(leaseLost.checkId, 'replacement-worker', { status: 'blocked', batchId: complete!.batchId! });
    assert.equal((await store.get(leaseLost.checkId))?.status, 'blocked');
    await fs.writeFile(path.join(root, 'new-backlink.md'), '[New](source.md)\n');
    const accepted = await batches.enqueue({ batchId: complete!.batchId!, planId: (await batches.get(complete!.batchId!))!.planId,
      userId: 'reviewer', displayName: 'Reviewer' });
    let executions = 0;
    await createWorkspaceOperationBatchWorker({ store: batches, lock: directLock, resolveScope: async () => scope,
      hasExecution: async () => false, buildPlan: buildWorkspaceOperationBatchPlan,
      execute: async () => { executions += 1; throw new Error('must not write'); }, dependentReviews: async () => undefined }).tick();
    assert.equal((await batches.get(accepted.batchId))?.status, 'needs_review');
    assert.equal(executions, 0, 'the full execution worker rejects a new backlink before the first path write');
    assert.equal(await fs.readFile(path.join(root, 'source.md'), 'utf8'), '# Source\n');
    assert.equal(await fs.readFile(path.join(root, 'index.md'), 'utf8'), '[Source](source.md)\n');
    await assert.rejects(fs.stat(path.join(root, 'moved.md')), { code: 'ENOENT' });
    console.log('review checks: DB dedupe, requester isolation, durable lease restart, immutable saved result, read-only file/review state, revoked access, conflicts, lost lease and blocked result OK');
    console.log('review checks approval: introduced backlink invalidates the old immutable plan in full worker preflight without writes OK');
  } finally { await pg.close(); await fs.rm(root, { recursive: true, force: true }); }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
