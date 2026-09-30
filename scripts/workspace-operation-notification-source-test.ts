import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { WORKSPACE_OPERATION_REVIEW_STATEMENTS } from '../app/lib/db/workspace-operation-review-migration';
import { createWorkspaceOperationNotificationSource } from '../app/lib/files/workspace-operation-notification-source';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function main() {
  const postgres = new PGlite();
  try {
    for (const statement of WORKSPACE_OPERATION_REVIEW_STATEMENTS) await postgres.exec(statement);
    await postgres.exec(`CREATE TABLE mobile_inbox_read_states (
      user_id text, workspace_id text, item_key text, read_at bigint, dismissed_at bigint,
      created_at bigint, updated_at bigint, PRIMARY KEY (user_id, workspace_id, item_key))`);
    const workspace: WorkspaceContext = { workspaceId: 'workspace-a', workspaceType: 'personal',
      displayName: 'A', rootPath: '/private/a', legacy: false, status: 'active',
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
        canManageWorkspace: true, canRunAgent: true } };
    const source = createWorkspaceOperationNotificationSource({ now: () => 200,
      database: { transaction: (action) => postgres.transaction((transaction) =>
        action({ query: (sql, params) => transaction.query(sql, params) })) } });
    const scope = { userId: 'owner', workspace };
    const insert = async (id: string, status: string, workspaceId = 'workspace-a') => postgres.query(`
      INSERT INTO workspace_file_operation_reviews
      (review_id, plan_id, request_hash, request_json, preview_json, source_workspace_id,
       destination_workspace_id, actor_user_id, actor_id, actor_display_name, status, reason_codes_json, created_at, updated_at)
      VALUES ($1,$2,$2,$3,'{}',$4,$4,'owner','agent','Agent',$5,'[]',100,100)`,
    [id, 'a'.repeat(64), JSON.stringify({ kind: 'copy', selections: [{ sourcePath: 'Docs/skill.md', destinationPath: 'Skills/skill.md' }] }), workspaceId, status]);
    for (const status of ['pending', 'blocked', 'stale', 'failed', 'needs_recovery', 'applied', 'rejected', 'applying']) {
      await insert(`review-${status}`, status);
    }
    await insert('foreign', 'blocked', 'workspace-b');
    const result = await source.list(scope);
    assert.equal(result.unreadCount, 5);
    assert.deepEqual(new Set(result.items.map((item) => item.target.status)),
      new Set(['pending', 'blocked', 'stale', 'failed', 'needs_recovery']));
    assert.ok(result.items.every((item) => item.workspaceId === 'workspace-a' && item.detail === 'Docs/skill.md'));
    const blocked = result.items.find((item) => item.target.status === 'blocked')!;
    assert.equal(blocked.priority, 'high');
    assert.equal(new URL(blocked.deepLink, 'https://canvas.test').searchParams.get('workspaceOperationReview'), 'review-blocked');
    assert.equal((await source.markRead({ ...scope, itemId: blocked.id })).updated, 1);
    const afterRead = await source.list(scope);
    assert.equal(afterRead.unreadCount, 4);
    assert.equal(afterRead.items.length, 5, 'reading keeps unresolved actions visible');
    assert.equal(afterRead.items.find((item) => item.id === blocked.id)?.unread, false);
    assert.equal((await source.markRead({ ...scope, itemId: 'file-operation:foreign' })).updated, 0);
    assert.equal((await source.markRead({ ...scope, itemId: 'chat:review-pending' })).updated, 0);
    assert.equal((await source.list({ ...scope, userId: 'other' })).unreadCount, 5, 'read state is user-specific');
    assert.deepEqual(await source.list({ ...scope, workspace: { ...workspace, status: 'archived' } }), { items: [], unreadCount: 0 });
    assert.deepEqual(await source.list({ ...scope, workspace: { ...workspace, permissions: { ...workspace.permissions, canRead: false } } }), { items: [], unreadCount: 0 });
    await source.markRead(scope);
    assert.equal((await source.list(scope)).unreadCount, 0);
    await postgres.query(`UPDATE workspace_file_operation_reviews SET status='rejected',updated_at=300 WHERE review_id=$1`, ['review-blocked']);
    assert.equal((await source.list(scope)).items.length, 4, 'resolved reviews disappear');
    await postgres.query(`UPDATE workspace_file_operation_reviews SET status='stale',updated_at=300 WHERE review_id=$1`, ['review-pending']);
    assert.equal((await source.list(scope)).unreadCount, 1, 'a status update becomes unread again');
    for (let i = 0; i < 205; i += 1) await insert(`bulk-${i}`, 'pending');
    const bounded = await source.list(scope);
    assert.equal(bounded.items.length, 200);
    assert.equal(bounded.unreadCount, 206, 'unread count covers actions beyond the presentation limit');
    console.log('workspace-operation-notification-source-test: ok');
  } finally {
    await postgres.close();
  }
}

void main();
