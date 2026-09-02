import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';

import {
  migrateSqliteToPostgres,
  sqliteToPostgresTablePlan,
} from '../app/lib/db/sqlite-to-postgres-migration';

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

async function main(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-memory-sqlite-postgres-'));
  const sqlitePath = path.join(tempDir, 'source.sqlite');
  await fs.writeFile(sqlitePath, '');
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
      pool,
      prepareSource: (sqlite) => {
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
        `);
      },
    });

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

    const retry = await migrateSqliteToPostgres({ sqlitePath, pool });
    assert.equal(retry.memoryTables.every((table) => table.sourceRows === 1 && table.targetRows === 1), true);
  } finally {
    await postgres.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }

  console.log('sqlite-to-postgres migration plan tests passed');
}

void main();
