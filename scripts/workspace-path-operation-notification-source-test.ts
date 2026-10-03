import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { WORKSPACE_OPERATION_REVIEW_STATEMENTS } from '../app/lib/db/workspace-operation-review-migration';
import { createWorkspacePathOperationNotificationSource } from '../app/lib/files/workspace-operation-notification-source';
import { createWorkspacePathOperationProblemStore, sanitizeWorkspacePathOperationSelections,
  workspacePathOperationProblemErrorCode } from '../app/lib/files/workspace-path-operation-problems';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { FileVersionCenterDatabase } from '../app/lib/file-version-center/database';

async function main() {
  const postgres = new PGlite();
  try {
    for (let repeat = 0; repeat < 2; repeat += 1) {
      for (const statement of WORKSPACE_OPERATION_REVIEW_STATEMENTS) await postgres.exec(statement);
    }
    await postgres.exec(`CREATE TABLE mobile_inbox_read_states (
      user_id text,workspace_id text,item_key text,read_at bigint,dismissed_at bigint,
      created_at bigint,updated_at bigint,PRIMARY KEY(user_id,workspace_id,item_key))`);
    const workspace: WorkspaceContext = { workspaceId: 'workspace-a', workspaceType: 'personal',
      displayName: 'A', rootPath: '/private/a', legacy: false, status: 'active',
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
        canManageWorkspace: true, canRunAgent: true } };
    const database: FileVersionCenterDatabase = { transaction: (action) =>
      postgres.transaction((transaction) => action({ query: (sql, params) => transaction.query(sql, params) })) };
    const source = createWorkspacePathOperationNotificationSource({ now: () => 500, database });
    const problems = createWorkspacePathOperationProblemStore({ now: () => 100, database });
    const scope = { userId: 'owner', workspace };
    const request = { workspace, actorUserId: 'owner', kind: 'move' as const,
      selections: [{ sourcePath: './Docs//b.md', destinationPath: 'Archive/b.md' },
        { sourcePath: 'Docs/a.md', destinationPath: 'Archive/a.md' }, { sourcePath: '/private/secret.txt' }],
      error: Object.assign(new Error('/private/a: secret document content'), { code: 'EACCES' }) };
    await problems.record(request);
    let storedRows = await postgres.query<{ problem_id: string; updated_at: number; selections_json: string }>(
      'SELECT problem_id,updated_at,selections_json FROM workspace_path_operation_problems');
    const problemId = storedRows.rows[0].problem_id;
    assert.match(problemId, /^[a-f0-9]{64}$/u);
    const original = await problems.get(problemId);
    assert.deepEqual(original, { problemId, workspaceId: workspace.workspaceId, kind: 'move',
      selections: [{ sourcePath: 'Docs/a.md', destinationPath: 'Archive/a.md' },
        { sourcePath: 'Docs/b.md', destinationPath: 'Archive/b.md' }], errorCode: 'EACCES', createdAt: 100, updatedAt: 100 });
    assert.equal(await problems.get('../not-an-id'), null);
    assert.equal(workspacePathOperationProblemErrorCode(new Error('secret')), 'WORKSPACE_OPERATION_FAILED');
    assert.equal(workspacePathOperationProblemErrorCode({ code: '/private/secret' }), 'WORKSPACE_OPERATION_FAILED');
    assert.equal(workspacePathOperationProblemErrorCode({ code: 'a'.repeat(64) }), 'WORKSPACE_OPERATION_FAILED');
    assert.deepEqual(sanitizeWorkspacePathOperationSelections([{ sourcePath: '../private/a' },
      { sourcePath: 'C:\\private\\a' }, { sourcePath: 'https://host/a' }, { sourcePath: 'bad\nname' },
      { sourcePath: 'ok.md', destinationPath: '/private/b' }]), [{ sourcePath: 'ok.md' }]);
    let listed = await source.list(scope);
    assert.equal(listed.unreadCount, 1);
    const initialNotice = listed.items[0];
    assert.equal(initialNotice.id, `file-path-problem:${problemId}`);
    assert.equal(initialNotice.type, 'file.operation_attention');
    assert.equal(initialNotice.target.problemId, problemId);
    assert.equal(new URL(initialNotice.deepLink, 'https://canvas.test').searchParams.get('workspacePathProblem'), problemId);
    assert.equal(new URL(initialNotice.deepLink, 'https://canvas.test').searchParams.has('workspaceOperationReview'), false);
    assert.equal((await source.markRead({ ...scope, itemId: initialNotice.id })).updated, 1);
    assert.equal((await source.list(scope)).unreadCount, 0);
    assert.equal((await source.list(scope)).items.length, 1, 'read state does not resolve the problem');
    await problems.record({ ...request, selections: [...request.selections].reverse(), error: { code: 'EIO' } });
    storedRows = await postgres.query('SELECT problem_id,updated_at,selections_json FROM workspace_path_operation_problems');
    assert.equal(storedRows.rows.length, 1, 'canonical selections deduplicate across ordering and error codes');
    assert.equal(Number(storedRows.rows[0].updated_at), 101, 'same-millisecond recurrence is monotonic');
    assert.equal((await source.list(scope)).unreadCount, 1, 'recurrence is unread even when the read clock is ahead');
    assert.equal((await problems.get(problemId))?.errorCode, 'EIO');
    await source.markRead(scope);
    await problems.record(request);
    assert.equal((await source.list(scope)).unreadCount, 1, 'another recurrence remains visible and unread');
    assert.equal((await problems.get(problemId))?.updatedAt, 102);
    assert.equal((await source.list({ ...scope, userId: 'another-user' })).unreadCount, 1);
    await problems.record({ ...request, actorUserId: 'another-user' });
    assert.equal((await source.list(scope)).items.length, 2, 'initiating users have distinct problems');
    await problems.record({ ...request, selections: [], error: new Error('/private/another-secret') });
    listed = await source.list(scope);
    assert.equal(listed.items.length, 3, 'malformed requests still have a generic durable problem');
    assert.ok(listed.items.some((item) => item.detail === 'WORKSPACE_OPERATION_FAILED'));
    const before = listed.items.length;
    for (const denied of [ { ...workspace, status: 'archived' as const },
      { ...workspace, permissions: { ...workspace.permissions, canRead: false } } ]) {
      await problems.record({ ...request, workspace: denied });
      assert.deepEqual(await source.list({ ...scope, workspace: denied }), { items: [], unreadCount: 0 });
      assert.equal((await source.markRead({ ...scope, workspace: denied })).updated, 0);
    }
    assert.equal((await source.list(scope)).items.length, before);
    assert.deepEqual(await source.list({ ...scope, workspace: { ...workspace, workspaceId: 'workspace-b' } }), { items: [], unreadCount: 0 });
    assert.equal((await source.markRead({ ...scope, itemId: `file-path-problem:${'a'.repeat(64)}` })).updated, 0);
    assert.equal((await source.markRead({ ...scope, itemId: 'file-path-operation:../invalid' })).updated, 0);
    assert.equal((await source.markRead({ ...scope, itemId: `file-operation:${problemId}` })).updated, 0);

    const insertBatch = async (status: string, suffix = status, errorCode: string | null = null,
      mode = 'direct', workspaceId = 'workspace-a') => {
      const id = `batch-${suffix}-abcdefghijkl`;
      await postgres.query(`INSERT INTO workspace_file_operation_batches
        (batch_id,plan_id,workspace_id,review_ids_json,review_refs_json,plan_json,status,total_actions,error_code,
         authorization_json,created_at,updated_at)
        VALUES($1,$2,$3,'[]','[]',$4,$5,0,$6,$7,100,100)`,
      [id, 'a'.repeat(64), workspaceId, JSON.stringify({ actions: [
        { kind: 'delete', selections: [{ sourcePath: 'replaced.md' }] },
        { kind: 'move', selections: [{ sourcePath: './Docs/a.md', destinationPath: 'Archive/a.md' }] }],
      originalDocuments: [{ content: 'PRIVATE_DOCUMENT_CONTENT', path: '/private/file' }],
      linkPlan: { backupPath: '/private/backup' } }), status, errorCode,
      JSON.stringify({ mode, actorUserId: 'owner', actorSessionId: 'PRIVATE_SESSION_ID' })]);
      return id;
    };
    const active = ['queued', 'applying', 'blocked', 'needs_review', 'needs_recovery', 'failed'];
    for (const status of [...active, 'applied', 'undone', 'preview']) await insertBatch(status);
    const refusedUndoId = await insertBatch('applied', 'refused-undo', 'UNDO_CONFLICT');
    await insertBatch('blocked', 'review-lane', null, 'review');
    await insertBatch('blocked', 'foreign', null, 'direct', 'workspace-b');
    listed = await source.list(scope);
    const batchItems = listed.items.filter((item) => item.target.batchId);
    assert.equal(batchItems.length, 7);
    assert.deepEqual(new Set(batchItems.map((item) => item.target.status)),
      new Set(['queued', 'applying', 'blocked', 'stale', 'needs_recovery', 'failed']));
    assert.ok(batchItems.every((item) => item.target.operationKind === 'move'));
    for (const status of ['queued', 'applying']) assert.equal(batchItems.find((item) => item.target.status === status)?.priority, 'normal');
    const refusedUndo = batchItems.find((item) => item.target.batchId === refusedUndoId)!;
    assert.equal(refusedUndo.target.status, 'failed');
    assert.match(refusedUndo.detail, /UNDO_CONFLICT/u);
    const batchUrl = new URL(refusedUndo.deepLink, 'https://canvas.test');
    assert.equal(batchUrl.searchParams.get('workspacePathBatch'), refusedUndoId);
    assert.equal(batchUrl.searchParams.has('workspaceOperationReview'), false);
    const serialized = JSON.stringify(listed);
    for (const privateValue of ['/private/', 'PRIVATE_', 'actorUserId', 'actorSessionId', 'reviewId', 'originalDocuments', 'authorization']) {
      assert.equal(serialized.includes(privateValue), false, `${privateValue} must not leave the notification source`);
    }
    await source.markRead(scope);
    assert.equal((await source.list(scope)).unreadCount, 0);
    assert.equal((await source.list(scope)).items.length, 10);
    await postgres.query(`UPDATE workspace_file_operation_batches SET status='applied',error_code=NULL,updated_at=101 WHERE batch_id=$1`, [refusedUndoId]);
    assert.equal((await source.list(scope)).items.length, 9, 'successful terminal batches leave the attention list');
    for (let index = 0; index < 205; index += 1) await insertBatch('blocked', `bulk-${index}`);
    listed = await source.list(scope);
    assert.equal(listed.items.length, 200);
    assert.equal(listed.unreadCount, 205, 'full unread count is independent of the 200-item display limit');
    assert.equal((await source.markRead(scope)).updated, 214, 'mark all read covers rows beyond the display limit');
    assert.equal((await source.list(scope)).unreadCount, 0);
    assert.equal((await source.list(scope)).items.length, 200, 'mark all read never hides failures');
    const failure = new Error('database unavailable');
    const brokenStore = createWorkspacePathOperationProblemStore({ database: { transaction: async () => { throw failure; } } });
    await assert.rejects(brokenStore.record(request), (error) => error === failure, 'caller can preserve the original mutation error');
    console.log('workspace-path-operation-notification-source-test: ok');
  } finally { await postgres.close(); }
}

void main();
