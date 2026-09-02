import assert from 'node:assert/strict';

import { PGlite } from '@electric-sql/pglite';

import { runPostgresMigrations } from '../app/lib/db/postgres';

type PgQueryable = Parameters<typeof runPostgresMigrations>[0];

async function indexDefinitions(postgres: PGlite, tableName: string): Promise<Map<string, string>> {
  const result = await postgres.query<{ indexname: string; indexdef: string }>(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = $1
  `, [tableName]);
  return new Map(result.rows.map((row) => [row.indexname, row.indexdef]));
}

async function columnNames(postgres: PGlite, tableName: string): Promise<string[]> {
  const result = await postgres.query<{ column_name: string }>(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [tableName]);
  return result.rows.map((row) => row.column_name);
}

async function main(): Promise<void> {
  const postgres = new PGlite();
  const migrationTarget = postgres as unknown as PgQueryable;

  try {
    await runPostgresMigrations(migrationTarget);

    assert.deepEqual(
      (await columnNames(postgres, 'file_collaboration_lineages')).includes('trash_entry_id'),
      true,
    );
    assert.deepEqual((await columnNames(postgres, 'file_revisions')).includes('revision_number'), true);
    assert.deepEqual((await columnNames(postgres, 'file_locks')).includes('lineage_id'), true);
    assert.deepEqual((await columnNames(postgres, 'collaboration_documents')).includes('lineage_id'), true);

    const lineageIndexes = await indexDefinitions(postgres, 'file_collaboration_lineages');
    assert.match(lineageIndexes.get('idx_file_collaboration_lineages_active_path') || '', /WHERE \(status = 'active'/u);

    const lockIndexes = await indexDefinitions(postgres, 'file_locks');
    assert.match(lockIndexes.get('idx_file_locks_single_active_path') || '', /UNIQUE/u);
    assert.match(lockIndexes.get('idx_file_locks_single_active_path') || '', /WHERE \(status = 'active'/u);

    const documentIndexes = await indexDefinitions(postgres, 'collaboration_documents');
    assert.match(documentIndexes.get('idx_collab_documents_workspace_path_provider') || '', /WHERE \(status = 'active'/u);

    // Simulate the index shape created before collaboration metadata moved to
    // PostgreSQL and prove that the migration is repeatable and repairs it.
    await postgres.exec(`
      DROP INDEX idx_collab_documents_workspace_path_provider;
      CREATE UNIQUE INDEX idx_collab_documents_workspace_path_provider
      ON collaboration_documents (workspace_id, path, provider);
    `);
    await runPostgresMigrations(migrationTarget);
    await runPostgresMigrations(migrationTarget);

    const upgradedDocumentIndexes = await indexDefinitions(postgres, 'collaboration_documents');
    assert.match(
      upgradedDocumentIndexes.get('idx_collab_documents_workspace_path_provider') || '',
      /WHERE \(status = 'active'/u,
    );

    await postgres.exec(`
      INSERT INTO file_collaboration_lineages (
        id, workspace_id, workspace_type, path, status, created_at, archived_at
      ) VALUES ('lineage-archived', 'workspace-1', 'personal', 'notes.md', 'archived', 1, 2);
      INSERT INTO file_collaboration_lineages (
        id, workspace_id, workspace_type, path, status, created_at
      ) VALUES ('lineage-active', 'workspace-1', 'personal', 'notes.md', 'active', 2);
      INSERT INTO collaboration_documents (
        id, workspace_id, workspace_type, path, lineage_id, provider, state_version, status, created_at, updated_at
      ) VALUES (
        'document-archived', 'workspace-1', 'personal', 'notes.md', 'lineage-archived', 'yjs', 0, 'archived', 1, 1
      );
      INSERT INTO collaboration_documents (
        id, workspace_id, workspace_type, path, lineage_id, provider, state_version, status, created_at, updated_at
      ) VALUES (
        'document-active', 'workspace-1', 'personal', 'notes.md', 'lineage-active', 'yjs', 0, 'active', 2, 2
      );
      INSERT INTO file_revisions (
        id, workspace_id, workspace_type, path, content_hash, size_bytes,
        created_by_actor_type, lineage_id, revision_number, created_at
      ) VALUES (
        'revision-1', 'workspace-1', 'personal', 'notes.md', 'hash-1', 1,
        'user', 'lineage-active', 1, 2
      );
    `);

    await assert.rejects(
      postgres.exec(`
        INSERT INTO file_locks (
          id, workspace_id, workspace_type, path, lock_type, status, expires_at, created_at, updated_at
        ) VALUES
          ('lock-1', 'workspace-1', 'personal', 'notes.md', 'edit', 'active', 20, 10, 10),
          ('lock-2', 'workspace-1', 'personal', 'notes.md', 'edit', 'active', 20, 10, 10)
      `),
    );
    await postgres.exec(`
      INSERT INTO file_locks (
        id, workspace_id, workspace_type, path, lock_type, status, expires_at, created_at, updated_at
      ) VALUES (
        'upload-lock', 'workspace-1', 'personal', 'upload.bin', 'upload', 'active', 20, 10, 10
      )
    `);
    await assert.rejects(
      postgres.exec(`
        INSERT INTO file_locks (
          id, workspace_id, workspace_type, path, lock_type, status, expires_at, created_at, updated_at
        ) VALUES (
          'invalid-lock', 'workspace-1', 'personal', 'invalid.bin', 'invalid', 'active', 20, 10, 10
        )
      `),
    );

  } finally {
    await postgres.close();
  }

  console.log('file-collaboration-postgres-schema-test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
