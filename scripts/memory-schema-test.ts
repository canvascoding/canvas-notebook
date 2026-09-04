import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import { getPostgresSchemaTableName, getPostgresSchemaTables } from '../app/lib/db/postgres';

const sqlite = new Database(':memory:');

try {
  sqlite.pragma('foreign_keys = ON');
  runMigrations(sqlite);
  runMigrations(sqlite);

  const expectedTables = [
    'memory_user_settings',
    'memory_review_runtime_settings',
    'memory_collections',
    'memory_entries',
    'memory_events',
    'memory_review_jobs',
  ];
  const sqliteTables = new Set((sqlite.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
  `).all() as Array<{ name: string }>).map((row) => row.name));
  assert.deepEqual(expectedTables.every((table) => sqliteTables.has(table)), true);
  const organizationPermissionColumns = new Set((sqlite.prepare(`PRAGMA table_info(organization_user_permissions)`).all() as Array<{ name: string }>).map((row) => row.name));
  assert.equal(organizationPermissionColumns.has('can_manage_organization_memory'), true);
  const reviewJobColumns = new Set((sqlite.prepare(`PRAGMA table_info(memory_review_jobs)`).all() as Array<{ name: string }>).map((row) => row.name));
  assert.deepEqual([
    'response_json',
    'response_hash',
    'response_recorded_at',
    'result_json',
    'failed_at',
  ].every((column) => reviewJobColumns.has(column)), true);

  sqlite.exec(`
    INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
    VALUES ('memory-user', 'Memory User', 'memory@example.test', 1, 1, 1);
    INSERT INTO memory_user_settings (user_id, created_at, updated_at)
    VALUES ('memory-user', 1, 1);
  `);
  const settings = sqlite.prepare(`
    SELECT automatic_memory_enabled, memory_prompt_max_tokens, sensitive_memory_enabled
    FROM memory_user_settings
    WHERE user_id = 'memory-user'
  `).get() as { automatic_memory_enabled: number; memory_prompt_max_tokens: number; sensitive_memory_enabled: number };
  assert.deepEqual(settings, {
    automatic_memory_enabled: 1,
    memory_prompt_max_tokens: 2000,
    sensitive_memory_enabled: 0,
  });

  sqlite.exec(`
    INSERT INTO memory_collections (
      id, scope_type, user_id, category, title, created_at, updated_at
    ) VALUES ('collection-1', 'user', 'memory-user', 'preferences', 'Preferences', 1, 1);
    INSERT INTO memory_entries (
      id, collection_id, content, normalized_content_hash, status, priority,
      estimated_tokens, created_by_actor_type, created_at, updated_at
    ) VALUES ('entry-1', 'collection-1', 'Prefers concise answers.', 'hash-1', 'published', 80, 6, 'assistant', 1, 1);
    INSERT INTO memory_events (id, entry_id, action, actor_type, created_at)
    VALUES ('event-1', 'entry-1', 'add', 'assistant', 1);
    INSERT INTO memory_review_jobs (
      id, user_id, session_id, from_message_sequence, through_message_sequence,
      trigger_type, status, created_at
    ) VALUES ('job-1', 'memory-user', 'session-1', 1, 10, 'turn_interval', 'scheduled', 1);
  `);

  assert.throws(() => sqlite.exec(`
    INSERT INTO memory_review_jobs (
      id, user_id, session_id, from_message_sequence, through_message_sequence,
      trigger_type, status, created_at
    ) VALUES ('job-duplicate', 'memory-user', 'session-1', 1, 10, 'idle', 'scheduled', 1);
  `), /UNIQUE constraint failed/);
  assert.throws(() => sqlite.exec(`
    INSERT INTO memory_entries (
      id, collection_id, content, normalized_content_hash, status, priority,
      estimated_tokens, created_by_actor_type, created_at, updated_at
    ) VALUES ('entry-invalid', 'collection-1', 'Invalid', 'hash-2', 'published', 101, 1, 'assistant', 1, 1);
  `), /CHECK constraint failed/);

  const postgresTables = new Set(getPostgresSchemaTables().map(getPostgresSchemaTableName));
  assert.deepEqual(expectedTables.every((table) => postgresTables.has(table)), true);
} finally {
  sqlite.close();
}

console.log('memory-schema-test: ok');
