import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import {
  FILE_VERSION_CENTER_STORAGE_UP_SQL,
  rollbackFileVersionCenterStorageMigration,
} from '../app/lib/db/file-version-center-migration';
import { runPostgresMigrations } from '../app/lib/db/postgres';

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];

const FVRC_TABLES = [
  'file_agent_review_policies',
  'file_change_group_entries',
  'file_change_groups',
  'file_revision_contents',
  'file_version_blobs',
] as const;

async function tableNames(postgres: PGlite): Promise<string[]> {
  const result = await postgres.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY($1)
    ORDER BY table_name
  `, [[...FVRC_TABLES]]);
  return result.rows.map((row) => row.table_name);
}

async function createScope(postgres: PGlite): Promise<void> {
  await postgres.exec(`
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES
      ('owner', 'Owner', 'owner@fvrc.test', 1, 1, 1),
      ('other', 'Other', 'other@fvrc.test', 1, 1, 1);
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
      ('lineage-b', 'workspace-b', 'personal', 'notes.md', 'active', 1);
    INSERT INTO file_revisions (
      id, workspace_id, workspace_type, path, content_hash, size_bytes,
      created_by_actor_type, lineage_id, revision_number, created_at
    ) VALUES
      ('revision-a', 'workspace-a', 'personal', 'notes.md', repeat('a', 64), 5,
       'user', 'lineage-a', 1, 1),
      ('revision-b', 'workspace-b', 'personal', 'notes.md', repeat('b', 64), 5,
       'user', 'lineage-b', 1, 1);
    INSERT INTO collaboration_documents (
      id, workspace_id, workspace_type, path, lineage_id, provider,
      state_version, status, created_at, updated_at
    ) VALUES
      ('document-a', 'workspace-a', 'personal', 'notes.md', 'lineage-a', 'yjs', 0, 'active', 1, 1),
      ('document-b', 'workspace-b', 'personal', 'notes.md', 'lineage-b', 'yjs', 0, 'active', 1, 1);
    INSERT INTO pi_sessions (
      session_id, user_id, agent_id, provider, model, workspace_id,
      workspace_type, created_at, updated_at
    ) VALUES
      ('session-a', 'owner', 'main', 'test', 'test', 'workspace-a', 'personal', 1, 1),
      ('session-b', 'other', 'main', 'test', 'test', 'workspace-b', 'personal', 1, 1);
    INSERT INTO collaboration_agent_operations (
      operation_id, document_id, workspace_id, initiated_by_user_id, actor_id,
      idempotency_key, payload_hash, status, base_state_vector, created_at, updated_at
    ) VALUES
      ('operation-a', 'document-a', 'workspace-a', 'owner', 'main', 'op-a', repeat('c', 64), 'needs_review', '\\x00', 1, 1),
      ('operation-b', 'document-b', 'workspace-b', 'other', 'main', 'op-b', repeat('d', 64), 'needs_review', '\\x00', 1, 1);
  `);
}

async function assertEmptyAndRepeatedMigration(): Promise<void> {
  const postgres = new PGlite();
  try {
    const target = postgres as unknown as PgQueryable;
    await runPostgresMigrations(target);
    await runPostgresMigrations(target);
    assert.deepEqual(await tableNames(postgres), [...FVRC_TABLES]);
  } finally {
    await postgres.close();
  }
}

async function assertPrefilledMigrationAndConstraints(): Promise<void> {
  const postgres = new PGlite();
  try {
    const target = postgres as unknown as PgQueryable;
    await runPostgresMigrations(target);
    await createScope(postgres);
    const session = await postgres.query<{ id: number }>(
      `SELECT id FROM pi_sessions WHERE session_id = 'session-a'`,
    );
    const sessionId = session.rows[0]!.id;
    const compressed = Buffer.from('compressed');
    await postgres.query(`
      INSERT INTO file_version_blobs (
        blob_id, workspace_id, content_sha256, codec, raw_size_bytes,
        stored_size_bytes, compressed_content, created_at
      ) VALUES ($1, 'workspace-a', $2, 'gzip', 5, $3, $4, 1)
    `, ['blob-a', 'a'.repeat(64), compressed.byteLength, compressed]);
    await postgres.exec(`
      INSERT INTO file_revision_contents (
        revision_id, workspace_id, lineage_id, blob_id, content_format, source, created_at
      ) VALUES ('revision-a', 'workspace-a', 'lineage-a', 'blob-a', 'markdown', 'initial', 1);
      INSERT INTO file_agent_review_policies (
        user_id, workspace_id, lineage_id, requested_mode, revision, created_at, updated_at
      ) VALUES ('owner', 'workspace-a', 'lineage-a', 'safe_direct', 1, 1, 1);
    `);
    await postgres.query(`
      INSERT INTO file_change_groups (
        group_id, workspace_id, user_id, source_session_id, pi_session_db_id,
        tool_call_id, operation, status, created_at, updated_at
      ) VALUES ('group-a', 'workspace-a', 'owner', 'session-a', $1,
        'tool-a', 'write', 'review_required', 1, 1)
    `, [sessionId]);
    await postgres.exec(`
      INSERT INTO file_change_group_entries (
        entry_id, change_group_id, workspace_id, ordinal, lineage_id,
        document_id, operation_id, path_hint, outcome, created_at
      ) VALUES (
        'entry-a', 'group-a', 'workspace-a', 0, 'lineage-a',
        'document-a', 'operation-a', 'notes.md', 'review_required', 1
      );
    `);

    await runPostgresMigrations(target);
    assert.equal((await postgres.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM file_revision_contents',
    )).rows[0]?.count, '1');
    await assert.rejects(postgres.exec(`
      INSERT INTO file_agent_review_policies (
        user_id, workspace_id, lineage_id, requested_mode, revision, created_at, updated_at
      ) VALUES ('owner', 'workspace-b', 'lineage-a', 'safe_direct', 1, 1, 1)
    `));
    await assert.rejects(postgres.exec(`
      INSERT INTO file_revision_contents (
        revision_id, workspace_id, lineage_id, blob_id, content_format, source, created_at
      ) VALUES ('revision-b', 'workspace-b', 'lineage-b', 'blob-a', 'markdown', 'initial', 1)
    `));
    await assert.rejects(postgres.query(`
      INSERT INTO file_change_groups (
        group_id, workspace_id, user_id, source_session_id, pi_session_db_id,
        tool_call_id, operation, status, created_at, updated_at
      ) VALUES ('group-cross-user', 'workspace-a', 'other', 'session-a', $1,
        'tool-cross-user', 'write', 'failed', 1, 1)
    `, [sessionId]));
    await assert.rejects(postgres.exec(`
      INSERT INTO file_change_group_entries (
        entry_id, change_group_id, workspace_id, ordinal, lineage_id,
        path_hint, outcome, created_at
      ) VALUES ('entry-gap', 'group-a', 'workspace-a', 100, 'lineage-a', 'notes.md', 'failed', 1)
    `));
  } finally {
    await postgres.close();
  }
}

async function assertRollbackAndAtomicFailure(): Promise<void> {
  const postgres = new PGlite();
  try {
    const target = postgres as unknown as PgQueryable;
    await runPostgresMigrations(target);
    await rollbackFileVersionCenterStorageMigration(postgres);
    assert.deepEqual(await tableNames(postgres), []);

    await postgres.exec('CREATE TABLE file_change_groups (group_id bigint PRIMARY KEY)');
    await assert.rejects(postgres.exec(FILE_VERSION_CENTER_STORAGE_UP_SQL));
    assert.deepEqual(
      await tableNames(postgres),
      ['file_change_groups'],
      'a failed migration batch must not leave earlier FVRC tables behind',
    );
  } finally {
    await postgres.close();
  }
}

async function main(): Promise<void> {
  await assertEmptyAndRepeatedMigration();
  await assertPrefilledMigrationAndConstraints();
  await assertRollbackAndAtomicFailure();
  console.log('file-version-center-storage-migration-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
