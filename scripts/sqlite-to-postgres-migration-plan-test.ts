import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import Database from 'better-sqlite3';
import type { Pool } from 'pg';

import {
  migrateSqliteToPostgres,
  sqliteToPostgresTablePlan,
} from '../app/lib/db/sqlite-to-postgres-migration';
import { runMigrations } from '../app/lib/db/migrate';

const plan = sqliteToPostgresTablePlan();
const position = new Map(plan.map((table, index) => [table, index]));

function before(dependency: string, dependent: string): void {
  assert.ok(position.has(dependency), `missing dependency table: ${dependency}`);
  assert.ok(position.has(dependent), `missing dependent table: ${dependent}`);
  assert.ok(
    position.get(dependency)! < position.get(dependent)!,
    `${dependency} must be copied before ${dependent}`,
  );
}

assert.equal(new Set(plan).size, plan.length, 'table plan must not contain duplicates');

before('user', 'account');
before('user', 'session');
before('user', 'canvas_organization_settings');
before('canvas_organization_settings', 'organization_user_permissions');
before('canvas_organization_settings', 'canvas_workspaces');
before('canvas_projects', 'canvas_project_members');
before('canvas_workspaces', 'workspace_trash_entries');
before('email_accounts', 'email_drafts');
before('todo_items', 'todo_file_links');
before('todo_email_reply_watchers', 'todo_email_reply_events');
before('knowledge_sources', 'knowledge_chunks');
before('automation_jobs', 'automation_runs');
before('automation_jobs', 'automation_webhook_triggers');
before('automation_webhook_triggers', 'automation_webhook_events');
before('studio_products', 'studio_product_images');
before('studio_personas', 'studio_persona_images');
before('studio_styles', 'studio_style_images');
before('user', 'memory_user_settings');
before('user', 'memory_collections');
before('memory_collections', 'memory_entries');
before('memory_entries', 'memory_events');
before('user', 'memory_legacy_imports');
before('user', 'memory_review_jobs');
before('file_collaboration_lineages', 'file_revisions');

function prepareSqliteSource(sqlitePath: string): void {
  const sqlite = new Database(sqlitePath);
  try {
    runMigrations(sqlite);
    sqlite.exec(`
      INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
      VALUES ('memory-user', 'Memory User', 'memory@example.test', 1, 1000, 1000);
      INSERT INTO memory_user_settings (
        user_id, automatic_memory_enabled, memory_prompt_max_tokens,
        sensitive_memory_enabled, created_at, updated_at
      ) VALUES ('memory-user', 1, 1800, 0, 1000, 1000);
      INSERT INTO memory_collections (
        id, scope_type, user_id, category, title, sensitivity, status,
        revision, created_by_user_id, created_at, updated_at
      ) VALUES (
        'memory-collection', 'user', 'memory-user', 'profile', 'User memory',
        'standard', 'active', 1, 'memory-user', 1000, 1000
      );
      INSERT INTO memory_entries (
        id, collection_id, semantic_key, content, normalized_content_hash,
        status, priority, pinned, sensitivity, estimated_tokens,
        source_session_id, source_agent_id, created_by_actor_type,
        created_by_user_id, last_confirmed_at, revision, created_at, updated_at
      ) VALUES (
        'memory-entry', 'memory-collection', 'profile.name', 'The user is Frank.',
        'memory-hash', 'published', 70, 0, 'standard', 5,
        'onboarding-session', 'bradley', 'assistant', 'memory-user',
        1000, 1, 1000, 1000
      );
      INSERT INTO memory_events (
        id, entry_id, action, actor_type, actor_user_id, session_id,
        decision_code, created_at
      ) VALUES (
        'memory-event', 'memory-entry', 'add', 'assistant', 'memory-user',
        'onboarding-session', 'onboarding_profile', 1000
      );
      INSERT INTO memory_legacy_imports (
        id, user_id, agent_id, file_name, content_hash,
        entries_imported, entries_skipped, completed_at
      ) VALUES (
        'memory-import', 'memory-user', 'bradley', 'USER.md',
        'legacy-hash', 1, 0, 1000
      );
      INSERT INTO memory_review_jobs (
        id, user_id, session_id, from_message_sequence,
        through_message_sequence, trigger_type, status, attempts, created_at
      ) VALUES (
        'memory-review', 'memory-user', 'onboarding-session', 1, 1,
        'session_close', 'completed', 1, 1000
      );
      INSERT INTO file_revisions (
        id, workspace_id, workspace_type, path, content_hash, size_bytes,
        created_by_user_id, created_by_actor_type, created_at
      ) VALUES (
        'legacy-revision', 'legacy-workspace', 'personal', 'notes.md',
        'legacy-content-hash', 12, 'memory-user', 'user', 1100
      );
      INSERT INTO file_locks (
        id, workspace_id, workspace_type, path, revision_id,
        locked_by_user_id, lock_type, status, expires_at, created_at, updated_at
      ) VALUES (
        'legacy-lock', 'legacy-workspace', 'personal', 'notes.md',
        'legacy-revision', 'memory-user', 'edit', 'active', 2100, 1100, 1100
      );
      INSERT INTO collaboration_documents (
        id, workspace_id, workspace_type, path, provider, state_version,
        snapshot_revision_id, status, created_at, updated_at
      ) VALUES (
        'legacy-document', 'legacy-workspace', 'personal', 'notes.md',
        'yjs', 4, 'legacy-revision', 'active', 1100, 1100
      );
    `);
  } finally {
    sqlite.close();
  }
}

async function assertCollaborationOnlyImport(tempDir: string): Promise<void> {
  const sqlitePath = path.join(tempDir, 'collaboration-only.sqlite');
  const sqlite = new Database(sqlitePath);
  try {
    runMigrations(sqlite);
    sqlite.exec(`
      INSERT INTO file_revisions (
        id, workspace_id, workspace_type, path, content_hash, size_bytes,
        created_by_actor_type, created_at
      ) VALUES (
        'sidecar-revision', 'sidecar-workspace', 'personal', 'shared.md',
        'sidecar-content-hash', 17, 'agent', 1200
      );
    `);
  } finally {
    sqlite.close();
  }

  const postgres = new PGlite();
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      const result = await postgres.query(sql, params as never[] | undefined);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    },
  } as unknown as Pool;

  try {
    const summary = await migrateSqliteToPostgres({
      sqlitePath,
      backupRoot: path.join(tempDir, 'collaboration-only-backups'),
      pool,
      offlineConfirmed: true,
    });
    assert.equal(summary.sourceUserCount, 0);
    assert.equal(
      summary.collaborationTables.find((table) => table.table === 'file_revisions')?.sourceRows,
      1,
    );
  } finally {
    await postgres.close();
  }
}

async function main(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-memory-sqlite-postgres-'));
  const sqlitePath = path.join(tempDir, 'source.sqlite');
  const backupRoot = path.join(tempDir, 'migration-backups');
  prepareSqliteSource(sqlitePath);
  const originalSource = await fs.readFile(sqlitePath);
  const postgres = new PGlite();
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      const result = await postgres.query(sql, params as never[] | undefined);
      return { ...result, rowCount: result.affectedRows ?? result.rows.length };
    },
  } as unknown as Pool;

  try {
    await assert.rejects(
      migrateSqliteToPostgres({ sqlitePath, backupRoot, pool }),
      (error) => error instanceof Error
        && 'code' in error
        && error.code === 'maintenance_required',
    );
    const summary = await migrateSqliteToPostgres({
      sqlitePath,
      backupRoot,
      pool,
      offlineConfirmed: true,
    });
    assert.deepEqual(await fs.readFile(sqlitePath), originalSource, 'the original SQLite source must remain unchanged');
    assert.equal(await fs.stat(summary.backup.snapshotPath).then((stats) => stats.isFile()), true);
    const manifest = JSON.parse(await fs.readFile(summary.backup.manifestPath, 'utf8')) as {
      purpose?: string;
      snapshotSha256?: string;
    };
    assert.equal(manifest.purpose, 'sqlite-to-postgres-offline-import');
    assert.equal(manifest.snapshotSha256, summary.backup.sha256);
    assert.equal((await fs.readdir(summary.backup.directory)).includes('working.sqlite.db'), false);

    assert.deepEqual(
      summary.memoryTables.map(({ table, sourceRows, targetRows }) => ({ table, sourceRows, targetRows })),
      [
        { table: 'memory_user_settings', sourceRows: 1, targetRows: 1 },
        { table: 'memory_collections', sourceRows: 1, targetRows: 1 },
        { table: 'memory_entries', sourceRows: 1, targetRows: 1 },
        { table: 'memory_events', sourceRows: 1, targetRows: 1 },
        { table: 'memory_legacy_imports', sourceRows: 1, targetRows: 1 },
        { table: 'memory_review_jobs', sourceRows: 1, targetRows: 1 },
      ],
    );
    const migrated = await postgres.query<{
      semantic_key: string;
      content: string;
      decision_code: string;
      session_id: string;
    }>(`
      SELECT entry.semantic_key, entry.content, event.decision_code, event.session_id
      FROM memory_entries entry
      INNER JOIN memory_events event ON event.entry_id = entry.id
      WHERE entry.id = 'memory-entry'
    `);
    assert.deepEqual(migrated.rows, [{
      semantic_key: 'profile.name',
      content: 'The user is Frank.',
      decision_code: 'onboarding_profile',
      session_id: 'onboarding-session',
    }]);

    assert.deepEqual(
      summary.collaborationTables.map(({ table, sourceRows, targetRows }) => ({ table, sourceRows, targetRows })),
      [
        { table: 'file_collaboration_lineages', sourceRows: 1, targetRows: 1 },
        { table: 'file_revisions', sourceRows: 1, targetRows: 1 },
        { table: 'file_locks', sourceRows: 1, targetRows: 1 },
        { table: 'collaboration_documents', sourceRows: 1, targetRows: 1 },
      ],
    );
    const collaboration = await postgres.query<{
      lineage_id: string;
      revision_number: number;
      content_hash: string;
      document_lineage_id: string;
      lock_lineage_id: string;
    }>(`
      SELECT
        revisions.lineage_id,
        revisions.revision_number,
        revisions.content_hash,
        documents.lineage_id AS document_lineage_id,
        locks.lineage_id AS lock_lineage_id
      FROM file_revisions AS revisions
      INNER JOIN collaboration_documents AS documents
        ON documents.snapshot_revision_id = revisions.id
      INNER JOIN file_locks AS locks
        ON locks.revision_id = revisions.id
      WHERE revisions.id = 'legacy-revision'
    `);
    assert.equal(collaboration.rows[0]?.lineage_id.startsWith('file-lineage-import-'), true);
    assert.equal(Number(collaboration.rows[0]?.revision_number), 1);
    assert.equal(collaboration.rows[0]?.document_lineage_id, collaboration.rows[0]?.lineage_id);
    assert.equal(collaboration.rows[0]?.lock_lineage_id, collaboration.rows[0]?.lineage_id);

    const retry = await migrateSqliteToPostgres({
      sqlitePath,
      backupRoot,
      pool,
      offlineConfirmed: true,
    });
    assert.equal(retry.memoryTables.every((table) => table.sourceRows === 1 && table.targetRows === 1), true);
    assert.equal(retry.tables.reduce((total, table) => total + table.insertedRows, 0), 0);
    assert.deepEqual(await fs.readFile(sqlitePath), originalSource, 'an idempotent retry must not mutate SQLite');

    await postgres.query("UPDATE file_revisions SET content_hash = 'conflicting-target-hash' WHERE id = 'legacy-revision'");
    await assert.rejects(
      migrateSqliteToPostgres({ sqlitePath, backupRoot, pool, offlineConfirmed: true }),
      (error) => error instanceof Error
        && 'code' in error
        && error.code === 'target_validation_failed'
        && /conflicting migrated rows/u.test(error.message),
    );
    await assertCollaborationOnlyImport(tempDir);
  } finally {
    await postgres.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  console.log('sqlite-to-postgres migration plan tests passed');
}

void main();
