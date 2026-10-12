import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { WORKSPACE_OPERATION_REVIEW_STATEMENTS } from '../app/lib/db/workspace-operation-review-migration';
import { createWorkspaceOperationNotificationSource, createWorkspacePathOperationNotificationSource } from '../app/lib/files/workspace-operation-notification-source';
import { createWorkspacePathOperationProblemStore } from '../app/lib/files/workspace-path-operation-problems';
import type { FileVersionCenterDatabase } from '../app/lib/file-version-center/database';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function main() {
  const postgres = new PGlite();
  try {
    for (const statement of WORKSPACE_OPERATION_REVIEW_STATEMENTS) await postgres.exec(statement);
    await postgres.exec(`CREATE TABLE mobile_inbox_read_states (
      user_id text,workspace_id text,item_key text,read_at bigint,dismissed_at bigint,
      created_at bigint,updated_at bigint,PRIMARY KEY(user_id,workspace_id,item_key))`);
    const database: FileVersionCenterDatabase = { transaction: (action) =>
      postgres.transaction((transaction) => action({ query: (sql, params) => transaction.query(sql, params) })) };
    const workspace: WorkspaceContext = { workspaceId: 'workspace-a', workspaceType: 'personal',
      displayName: 'A', rootPath: '/private/a', legacy: false, status: 'active',
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
        canManageWorkspace: true, canRunAgent: true } };
    const scope = { userId: 'owner', workspace };
    const options = { database, now: () => 500 };
    const reviews = createWorkspaceOperationNotificationSource(options);
    const paths = createWorkspacePathOperationNotificationSource(options);
    const problems = createWorkspacePathOperationProblemStore({ database, now: () => 100 });
    for (const status of ['blocked', 'stale', 'failed', 'needs_recovery', 'pending', 'queued', 'applying']) {
      await postgres.query(`INSERT INTO workspace_file_operation_reviews
        (review_id,plan_id,request_hash,request_json,preview_json,source_workspace_id,destination_workspace_id,
         actor_user_id,actor_id,actor_display_name,status,reason_codes_json,created_at,updated_at)
        VALUES($1,$2,$2,$3,'{}','workspace-a','workspace-a','owner','agent','Agent',$4,'[]',100,100)`,
      [`review-${status}`, 'a'.repeat(64), JSON.stringify({ kind: 'rename', selections: [{ sourcePath: 'before.md' }] }), status]);
    }
    for (const status of ['blocked', 'needs_review', 'failed', 'needs_recovery', 'queued', 'applying']) {
      await postgres.query(`INSERT INTO workspace_file_operation_batches
        (batch_id,plan_id,workspace_id,review_ids_json,review_refs_json,plan_json,status,total_actions,
         authorization_json,created_at,updated_at)
        VALUES($1,$2,'workspace-a','[]','[]',$3,$4,0,'{"mode":"direct"}',100,100)`,
      [`batch-${status}-abcdefghijkl`, 'a'.repeat(64), JSON.stringify({ actions: [{ kind: 'rename', selections: [{ sourcePath: 'before.md' }] }] }), status]);
    }
    const problem = { workspace, actorUserId: 'owner', kind: 'rename' as const,
      selections: [{ sourcePath: 'before.md', destinationPath: 'after.md' }], error: { code: 'EACCES' } };
    await problems.record(problem);

    for (const source of [reviews, paths]) {
      const initial = await source.list(scope);
      const failure = initial.items.find((item) => item.target.status === 'blocked')!;
      assert.equal(failure.notificationRevision, '100');
      const input = { ...scope, itemId: failure.id, expectedRevision: failure.notificationRevision };
      const underlyingBefore = await postgres.query('SELECT * FROM workspace_file_operation_reviews');
      const batchBefore = await postgres.query('SELECT * FROM workspace_file_operation_batches');
      const problemBefore = await postgres.query('SELECT * FROM workspace_path_operation_problems');
      assert.equal((await source.dismiss({ ...input, expectedRevision: '99' })).updated, 0, 'stale clients cannot hide a different version');
      assert.equal((await source.dismiss({ ...input, expectedRevision: '../invalid' })).updated, 0);
      assert.equal((await source.dismiss({ ...input, workspace: { ...workspace, workspaceId: 'workspace-b' } })).updated, 0);
      for (const denied of [{ ...workspace, status: 'archived' as const },
        { ...workspace, permissions: { ...workspace.permissions, canRead: false } }]) {
        assert.equal((await source.dismiss({ ...input, workspace: denied })).updated, 0);
      }
      assert.equal((await source.dismiss(input)).updated, 1);
      assert.equal((await source.dismiss(input)).updated, 1, 'repeated dismissal of the same version is idempotent');
      const hidden = await source.list(scope);
      assert.equal(hidden.items.length, initial.items.length - 1);
      assert.equal(hidden.unreadCount, initial.unreadCount - 1);
      assert.equal((await source.list({ ...scope, userId: 'another-user' })).items.length, initial.items.length);
      await source.markRead({ ...scope, itemId: failure.id });
      await source.markRead(scope);
      assert.equal((await source.list(scope)).items.some((item) => item.id === failure.id), false, 'reads do not restore dismissed errors');
      assert.deepEqual((await postgres.query('SELECT * FROM workspace_file_operation_reviews')).rows, underlyingBefore.rows);
      assert.deepEqual((await postgres.query('SELECT * FROM workspace_file_operation_batches')).rows, batchBefore.rows);
      assert.deepEqual((await postgres.query('SELECT * FROM workspace_path_operation_problems')).rows, problemBefore.rows);
      for (const item of initial.items.filter((item) => ['pending', 'queued', 'applying'].includes(item.target.status))) {
        assert.equal((await source.dismiss({ ...scope, itemId: item.id, expectedRevision: item.notificationRevision })).updated, 0,
          'pending approvals and processing notifications cannot be dismissed as errors');
      }
      const recreated = source === reviews ? createWorkspaceOperationNotificationSource(options) : createWorkspacePathOperationNotificationSource(options);
      assert.equal((await recreated.list(scope)).items.some((item) => item.id === failure.id), false, 'dismissal survives a new source instance');
      const table = source === reviews ? 'workspace_file_operation_reviews' : 'workspace_file_operation_batches';
      const idColumn = source === reviews ? 'review_id' : 'batch_id';
      const id = source === reviews ? 'review-blocked' : 'batch-blocked-abcdefghijkl';
      await postgres.query(`UPDATE ${table} SET updated_at=101,status='failed' WHERE ${idColumn}=$1`, [id]);
      assert.equal((await source.dismiss(input)).updated, 0, 'a delayed request cannot dismiss the new failure');
      const recurring = (await source.list(scope)).items.find((item) => item.id === failure.id)!;
      assert.equal(recurring.notificationRevision, '101');
      assert.equal(recurring.unread, true, 'new errors are unread even when the wall clock is ahead');
      for (const item of (await source.list(scope)).items.filter((item) => ['blocked', 'stale', 'failed', 'needs_recovery'].includes(item.target.status))) {
        assert.equal((await source.dismiss({ ...scope, itemId: item.id, expectedRevision: item.notificationRevision })).updated, 1);
      }
    }
    // The problem id is deduplicated across attempts; its monotonic version distinguishes a new failure.
    await problems.record(problem);
    const recurringProblem = (await paths.list(scope)).items.find((item) => item.target.problemId)!;
    assert.equal(recurringProblem.notificationRevision, '101');
    assert.equal(recurringProblem.unread, true);
    assert.equal((await paths.dismiss({ ...scope, itemId: recurringProblem.id, expectedRevision: '100' })).updated, 0);
    assert.equal((await paths.dismiss({ ...scope, itemId: recurringProblem.id, expectedRevision: '101' })).updated, 1);
    assert.equal((await paths.list(scope)).items.some((item) => item.target.problemId), false);
    // A worker heartbeat only updates running actions, which are not dismissible error notifications.
    await postgres.query(`UPDATE workspace_file_operation_batches SET updated_at=600 WHERE status='applying'`);
    assert.ok((await paths.list(scope)).items.every((item) => ['queued', 'applying'].includes(item.target.status)));
    const broken = createWorkspacePathOperationNotificationSource({ database: { transaction: async () => { throw new Error('offline'); } } });
    await assert.rejects(broken.dismiss({ ...scope, itemId: recurringProblem.id, expectedRevision: '101' }), /offline/u);
    console.log('workspace-operation-notification-dismiss-test: ok');
  } finally { await postgres.close(); }
}

void main();
