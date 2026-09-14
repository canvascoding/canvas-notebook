import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';

import { runPostgresMigrations } from '../app/lib/db/postgres';
import { createFileVersionContentStore } from '../app/lib/file-version-center/version-content-store';
import { createFileVersionCenterQueryService } from '../app/lib/file-version-center/query-service';
import type { FileVersionCenterDatabase } from '../app/lib/file-version-center/database';
import { FileVersionCenterContractError } from '../app/lib/file-version-center/contracts/v1';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function database(postgres: PGlite): FileVersionCenterDatabase {
  return {
    transaction: (action) => postgres.transaction(async (transaction) => action({
      query: <Row>(sql: string, params?: unknown[]) => transaction.query<Row>(sql, params),
    })),
  };
}

function workspace(id = 'workspace-a', canWrite = true): WorkspaceContext {
  return {
    workspaceId: id,
    workspaceType: 'personal',
    organizationId: 'org',
    customerId: null,
    projectId: null,
    rootPath: `/tmp/${id}`,
    displayName: id,
    status: 'active',
    permissions: {
      canRead: true,
      canWrite,
      canDelete: canWrite,
      canCreatePublicLinks: canWrite,
      canManageWorkspace: canWrite,
      canRunAgent: canWrite,
    },
    legacy: false,
  };
}

const access = (workspaceId = 'workspace-a', canWrite = true) => ({
  userId: 'owner',
  authenticatedWorkspaceId: workspaceId,
  requestedWorkspaceId: workspaceId,
  membership: 'active' as const,
  permissionsResolved: true,
  canRead: true,
  canWrite,
  canRunAgent: canWrite,
  canManageWorkspace: canWrite,
});

async function setup(postgres: PGlite): Promise<void> {
  await runPostgresMigrations(postgres as unknown as PgQueryable);
  await postgres.exec(`
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES
      ('owner', 'Owner', 'owner@query.test', 1, 1, 1),
      ('other', 'Other', 'other@query.test', 1, 1, 1);
    INSERT INTO canvas_organization_settings (
      organization_id, owner_user_id, deployment_mode, team_features_enabled, created_at, updated_at
    ) VALUES ('org', 'owner', 'team', 1, 1, 1);
    INSERT INTO canvas_workspaces (
      id, organization_id, type, owner_user_id, root_relative_path,
      display_name, workspace_icon, status, is_default, created_at, updated_at
    ) VALUES
      ('workspace-a', 'org', 'personal', 'owner', 'workspaces/a', 'A', 'user-round', 'active', 1, 1, 1),
      ('workspace-b', 'org', 'personal', 'other', 'workspaces/b', 'B', 'user-round', 'active', 0, 1, 1);
    INSERT INTO file_collaboration_lineages (
      id, organization_id, workspace_id, workspace_type, path, status, created_at, archived_at
    ) VALUES
      ('lineage-a', 'org', 'workspace-a', 'personal', 'renamed.md', 'active', 1, NULL),
      ('lineage-reused', 'org', 'workspace-a', 'personal', 'old.md', 'active', 60, NULL),
      ('lineage-archived', 'org', 'workspace-a', 'personal', 'old.md', 'archived', 1, 50),
      ('lineage-b', 'org', 'workspace-b', 'personal', 'renamed.md', 'active', 1, NULL);
    INSERT INTO collaboration_documents (
      id, organization_id, workspace_id, workspace_type, path, lineage_id,
      provider, state_version, status, created_at, updated_at
    ) VALUES
      ('document-a', 'org', 'workspace-a', 'personal', 'renamed.md', 'lineage-a', 'yjs', 3, 'active', 1, 30),
      ('document-b', 'org', 'workspace-b', 'personal', 'renamed.md', 'lineage-b', 'yjs', 1, 'active', 1, 10);
    INSERT INTO file_revisions (
      id, organization_id, workspace_id, workspace_type, path, content_hash,
      size_bytes, created_by_user_id, created_by_actor_type, lineage_id,
      revision_number, created_at
    ) VALUES
      ('revision-1', 'org', 'workspace-a', 'personal', 'renamed.md', '${sha256('# One\n')}', 6, 'owner', 'user', 'lineage-a', 1, 10),
      ('revision-2', 'org', 'workspace-a', 'personal', 'renamed.md', '${sha256('# Two\n')}', 6, 'owner', 'agent', 'lineage-a', 2, 20),
      ('revision-3', 'org', 'workspace-a', 'personal', 'renamed.md', '${sha256('# Three\n')}', 8, 'owner', 'user', 'lineage-a', 3, 30);
    INSERT INTO collaboration_agent_operations (
      operation_id, document_id, document_path, document_representation,
      workspace_id, organization_id, document_lifecycle_generation, schema_version,
      initiated_by_user_id, actor_id, idempotency_key, payload_hash, status,
      base_state_vector, created_at, updated_at
    ) VALUES
      ('operation-new', 'document-a', 'renamed.md', 'plain_text', 'workspace-a', 'org', 1, 1,
       'owner', 'agent-new', 'operation-new-key', repeat('a', 64), 'needs_review', '\\x00', 40, 50),
      ('operation-old', 'document-a', 'renamed.md', 'plain_text', 'workspace-a', 'org', 1, 1,
       'owner', 'agent-old', 'operation-old-key', repeat('b', 64), 'semantic_conflict', '\\x00', 35, 40);
    INSERT INTO pi_sessions (
      session_id, user_id, agent_id, provider, model, workspace_id,
      workspace_type, created_at, updated_at
    ) VALUES ('session-a', 'owner', 'main', 'test', 'test', 'workspace-a', 'personal', 1, 1);
  `);
  const store = createFileVersionContentStore({ database: database(postgres) });
  await store.bindRevisionContent({ revisionId: 'revision-1', workspaceId: 'workspace-a', lineageId: 'lineage-a',
    content: '# One\n', format: 'markdown', source: 'initial' });
  await store.bindRevisionContent({ revisionId: 'revision-2', workspaceId: 'workspace-a', lineageId: 'lineage-a',
    content: '# Two\n', format: 'markdown', source: 'agent_apply' });
  await store.bindRevisionContent({ revisionId: 'revision-3', workspaceId: 'workspace-a', lineageId: 'lineage-a',
    content: '# Three\n', format: 'markdown', source: 'manual' });
  const session = (await postgres.query<{ id: number }>(`SELECT id FROM pi_sessions WHERE session_id = 'session-a'`)).rows[0]!.id;
  await postgres.query(`
    INSERT INTO file_change_groups (
      group_id, workspace_id, user_id, source_session_id, pi_session_db_id,
      tool_call_id, payload_hash, operation, status, created_at, updated_at
    ) VALUES ('group-a', 'workspace-a', 'owner', 'session-a', $1,
      'tool-call-a', repeat('c', 64), 'edit_file', 'review_required', 40, 40)
  `, [session]);
  await postgres.exec(`
    INSERT INTO file_change_group_entries (
      entry_id, change_group_id, workspace_id, ordinal, lineage_id,
      document_id, operation_id, path_hint, outcome, created_at
    ) VALUES ('entry-a', 'group-a', 'workspace-a', 0, 'lineage-a',
      'document-a', 'operation-new', 'renamed.md', 'review_required', 40)
  `);
}

async function main(): Promise<void> {
  const postgres = new PGlite();
  try {
    await setup(postgres);
    const service = createFileVersionCenterQueryService({
      database: database(postgres),
      rolloutMode: () => 'full',
      current: async (target) => ({
        fence: {
          revisionId: target.latestRevisionId,
          sha256: target.latestRevisionHash!,
          stateVectorHash: sha256('state-vector'),
        },
        sizeBytes: target.latestRevisionSize,
        observedAt: 60,
      }),
      readPolicy: async () => ({
        contractVersion: 1,
        requestedMode: 'review_required',
        effectiveMode: 'review_required',
        revision: 0,
        locked: false,
        reason: 'default_review_required',
      }),
    });

    assert.equal((await service.resolve({
      target: { kind: 'document', workspaceId: 'workspace-a', documentId: 'document-a' },
      access: access(),
    })).lineageId, 'lineage-a');
    assert.equal((await service.resolve({
      target: { kind: 'change_group', workspaceId: 'workspace-a', changeGroupId: 'group-a', entryId: 'entry-a' },
      access: access(),
    })).documentId, 'document-a');
    assert.equal((await service.resolveOperation({
      operationId: 'operation-new', workspaceId: 'workspace-a', access: access(),
    })).lineageId, 'lineage-a');
    assert.equal((await service.resolve({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      access: access(),
    })).path, 'renamed.md');
    assert.equal((await service.resolve({
      target: { kind: 'path', workspaceId: 'workspace-a', pathHint: 'old.md' },
      access: access(),
    })).lineageId, 'lineage-reused');
    await assert.rejects(service.resolve({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-archived' },
      access: access(),
    }), (error: unknown) => error instanceof FileVersionCenterContractError && error.code === 'FVRC_NOT_FOUND');
    await assert.rejects(service.resolve({
      target: { kind: 'lineage', workspaceId: 'workspace-b', lineageId: 'lineage-b' },
      access: access(),
    }), (error: unknown) => error instanceof FileVersionCenterContractError && error.code === 'FVRC_ACCESS_DENIED');

    const first = await service.timeline({
      target: { kind: 'path', workspaceId: 'workspace-a', pathHint: 'renamed.md' },
      access: access(),
      workspace: workspace(),
      limit: 2,
    });
    assert.deepEqual(first.entries.map((entry) => entry.kind === 'agent_operation' ? entry.operationId : entry.kind),
      ['operation-new', 'operation-old']);
    assert.equal(first.page.hasMore, true);

    const second = await service.timeline({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      access: access(),
      workspace: workspace(),
      cursor: first.page.nextCursor!,
      limit: 2,
    });
    assert.deepEqual(second.entries.map((entry) => entry.kind === 'revision' ? entry.revisionId : entry.kind),
      ['current', 'revision-3']);
    assert.equal(second.page.hasMore, true);

    await postgres.exec(`
      INSERT INTO file_revisions (
        id, organization_id, workspace_id, workspace_type, path, content_hash,
        size_bytes, created_by_actor_type, lineage_id, revision_number, created_at
      ) VALUES ('revision-newer', 'org', 'workspace-a', 'personal', 'renamed.md', repeat('d', 64),
        9, 'user', 'lineage-a', 4, 100)
    `);
    const third = await service.timeline({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      access: access(),
      workspace: workspace(),
      cursor: second.page.nextCursor!,
      limit: 2,
    });
    assert.deepEqual(third.entries.map((entry) => entry.kind === 'revision' ? entry.revisionId : entry.kind),
      ['revision-2', 'revision-1']);
    assert.equal(third.page.hasMore, false);

    const readOnly = await service.timeline({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      access: access('workspace-a', false),
      workspace: workspace('workspace-a', false),
      limit: 5,
    });
    assert.equal(readOnly.capabilities.history, true);
    assert.equal(readOnly.capabilities.restore, false);
    assert.equal(readOnly.capabilities.reason, 'read_only');
    assert.equal(readOnly.entries.filter((entry) => entry.kind === 'agent_operation')
      .every((entry) => !entry.actionsAllowed), true);

    await assert.rejects(service.timeline({
      target: { kind: 'lineage', workspaceId: 'workspace-a', lineageId: 'lineage-a' },
      access: access(),
      workspace: workspace(),
      cursor: 'v1.not-json',
    }), (error: unknown) => error instanceof FileVersionCenterContractError && error.code === 'FVRC_INVALID_REQUEST');
    console.log('file-version-center-query-test: ok');
  } finally {
    await postgres.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
