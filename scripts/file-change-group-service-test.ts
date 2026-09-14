import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';

import { runPostgresMigrations } from '../app/lib/db/postgres';
import { createFileChangeGroupService, FileChangeGroupServiceError } from '../app/lib/file-version-center/change-group-service';
import type { FileVersionCenterDatabase } from '../app/lib/file-version-center/database';

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];

function database(postgres: PGlite): FileVersionCenterDatabase {
  return {
    transaction: (action) => postgres.transaction(async (transaction) => action({
      query: <Row>(sql: string, params?: unknown[]) => transaction.query<Row>(sql, params),
    })),
  };
}

const ownerAccess = {
  userId: 'owner', authenticatedWorkspaceId: 'workspace-a', requestedWorkspaceId: 'workspace-a',
  membership: 'active' as const, permissionsResolved: true, canRead: true, canWrite: true, canRunAgent: true,
};

function errorCode(expected: string) {
  return (error: unknown) => error instanceof FileChangeGroupServiceError && error.code === expected;
}

async function setup(postgres: PGlite): Promise<void> {
  await runPostgresMigrations(postgres as unknown as PgQueryable);
  const contentHash = createHash('sha256').update('# Notes\n').digest('hex');
  await postgres.exec(`
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES
      ('owner', 'Owner', 'owner@group.test', 1, 1, 1),
      ('other', 'Other', 'other@group.test', 1, 1, 1);
    INSERT INTO canvas_organization_settings (
      organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
    ) VALUES ('org', 'owner', 'team', 1, 1, 1);
    INSERT INTO canvas_workspaces (
      id, organization_id, type, owner_user_id, root_relative_path,
      display_name, workspace_icon, status, is_default, created_at, updated_at
    ) VALUES
      ('workspace-a', 'org', 'personal', 'owner', 'workspaces/a', 'A', 'user-round', 'active', 1, 1, 1),
      ('workspace-b', 'org', 'personal', 'other', 'workspaces/b', 'B', 'user-round', 'active', 1, 1, 1);
    INSERT INTO file_collaboration_lineages (
      id, workspace_id, workspace_type, path, status, created_at
    ) VALUES
      ('lineage-a', 'workspace-a', 'personal', 'notes.md', 'active', 1),
      ('lineage-b', 'workspace-b', 'personal', 'other.md', 'active', 1);
    INSERT INTO file_revisions (
      id, workspace_id, workspace_type, path, content_hash, size_bytes,
      created_by_actor_type, lineage_id, revision_number, created_at
    ) VALUES ('revision-a', 'workspace-a', 'personal', 'notes.md', '${contentHash}', 8,
      'user', 'lineage-a', 1, 1);
    INSERT INTO collaboration_documents (
      id, workspace_id, workspace_type, path, lineage_id, provider,
      state_version, status, created_at, updated_at
    ) VALUES ('document-a', 'workspace-a', 'personal', 'notes.md', 'lineage-a', 'yjs', 0, 'active', 1, 1);
    INSERT INTO pi_sessions (
      session_id, user_id, agent_id, provider, model, workspace_id,
      workspace_type, created_at, updated_at
    ) VALUES
      ('session-a', 'owner', 'main', 'test', 'test', 'workspace-a', 'personal', 1, 1),
      ('session-b', 'other', 'main', 'test', 'test', 'workspace-b', 'personal', 1, 1);
    INSERT INTO collaboration_agent_operations (
      operation_id, document_id, workspace_id, initiated_by_user_id, actor_id,
      idempotency_key, payload_hash, status, base_state_vector, created_at, updated_at
    ) VALUES ('operation-a', 'document-a', 'workspace-a', 'owner', 'main', 'op-a',
      repeat('c', 64), 'needs_review', '\\x00', 1, 1);
  `);
}

async function main(): Promise<void> {
  const postgres = new PGlite();
  try {
    await setup(postgres);
    const service = createFileChangeGroupService({ database: database(postgres), now: () => 1_700_000_000_000 });
    const request = {
      access: ownerAccess,
      sourceSessionId: 'session-a',
      toolCallId: 'tool-a',
      operation: 'apply_patch' as const,
      entries: [
        { lineageId: 'lineage-a', documentId: 'document-a', operationId: 'operation-a', revisionId: 'revision-a',
          pathHint: 'notes.md', outcome: 'review_required' as const, additions: 2, deletions: 1 },
        { lineageId: 'lineage-a', pathHint: 'appendix.md', outcome: 'failed' as const },
      ],
    };
    const [created, concurrentRetry] = await Promise.all([service.create(request), service.create(request)]);
    assert.equal(created.id, concurrentRetry.id);
    assert.equal(created.status, 'mixed');
    assert.deepEqual(created.entries.map((entry) => [entry.ordinal, entry.pathHint]), [
      [0, 'notes.md'], [1, 'appendix.md'],
    ]);
    assert.equal((await postgres.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM file_change_groups',
    )).rows[0]?.count, '1');

    const reloadedService = createFileChangeGroupService({ database: database(postgres), now: () => 2_000_000_000_000 });
    assert.deepEqual(await reloadedService.readAuthorized({ access: ownerAccess, groupId: created.id }), created);
    await assert.rejects(service.create({ ...request, entries: [...request.entries].reverse() }), errorCode('conflict'));

    await assert.rejects(reloadedService.readAuthorized({ access: { ...ownerAccess, userId: 'other' }, groupId: created.id }));
    await assert.rejects(reloadedService.readAuthorized({ access: { ...ownerAccess,
      authenticatedWorkspaceId: 'workspace-b', requestedWorkspaceId: 'workspace-b' }, groupId: created.id }));
    await assert.rejects(service.create({ ...request, toolCallId: 'tool-cross', entries: [{
      lineageId: 'lineage-b', pathHint: 'other.md', outcome: 'failed' as const,
    }] }), errorCode('target_invalid'));
    await assert.rejects(service.create({ ...request, toolCallId: 'tool-path', entries: [{
      pathHint: '../secret.md', outcome: 'failed' as const,
    }] }), errorCode('invalid_input'));

    await postgres.exec(`UPDATE pi_sessions SET archived_at = 2 WHERE session_id = 'session-a'`);
    assert.deepEqual(await reloadedService.readAuthorized({ access: ownerAccess, groupId: created.id }), created);
    assert.equal((await service.create(request)).id, created.id, 'an archived session may replay an already stored result');
    await assert.rejects(service.create({ ...request, toolCallId: 'tool-after-archive' }), errorCode('session_archived'));

    await assert.rejects(postgres.exec(`DELETE FROM file_collaboration_lineages WHERE id = 'lineage-a'`));
    await postgres.exec(`UPDATE file_collaboration_lineages SET status = 'archived', archived_at = 3 WHERE id = 'lineage-a'`);
    assert.equal((await reloadedService.readAuthorized({ access: ownerAccess, groupId: created.id })).entries[0]?.lineageId, 'lineage-a');
    assert.ok(!JSON.stringify(created).includes('# Notes'), 'change groups must never store document content');
    console.log('file-change-group-service-test: ok');
  } finally {
    await postgres.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
