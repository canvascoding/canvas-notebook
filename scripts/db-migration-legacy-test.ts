import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../app/lib/db/migrate';

const dataDir = mkdtempSync(path.join(tmpdir(), 'canvas-db-migration-'));
const dbPath = path.join(dataDir, 'sqlite.db');

try {
  const sqlite = new Database(dbPath);
  sqlite.exec(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      email_verified INTEGER NOT NULL,
      image TEXT,
      role TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE pi_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      summary_text TEXT,
      summary_updated_at INTEGER,
      summary_through_timestamp INTEGER,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

    CREATE TABLE pi_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      pi_session_db_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      FOREIGN KEY (pi_session_db_id) REFERENCES pi_sessions(id)
    );

    CREATE TABLE channel_active_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_session_key TEXT NOT NULL,
      channel_thread_key TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES user(id)
    );

    CREATE UNIQUE INDEX idx_channel_active_sessions_context
      ON channel_active_sessions (channel_id, channel_session_key, channel_thread_key);

    INSERT INTO user (id, name, email, email_verified, image, role, created_at, updated_at)
    VALUES ('user-migration', 'Migration User', 'migration@example.test', 1, NULL, NULL, 1700000000, 1700000000);

    INSERT INTO pi_sessions (id, session_id, user_id, provider, model, title, created_at, updated_at)
    VALUES
      (1, 'sess-migration', 'user-migration', 'test-provider', 'test-model', 'Migration Session', 1700000000, 1700000000),
      (2, 'sess-migration-old', 'user-migration', 'test-provider', 'test-model', 'Old Migration Session', 1699990000, 1699990000);

    INSERT INTO pi_messages (id, pi_session_db_id, role, content, timestamp)
    VALUES
      (10, 1, 'user', '{"role":"user","content":"first","timestamp":2000}', 2000),
      (20, 1, 'user', '{"role":"user","content":"second","timestamp":1000}', 1000);

    INSERT INTO channel_active_sessions (user_id, channel_id, channel_session_key, channel_thread_key, session_id, updated_at)
    VALUES ('user-migration', 'web', 'web:user:user-migration', '', 'sess-migration', 1700000100);
  `);

  runMigrations(sqlite);

  assert.equal(tableExists(sqlite, 'ai_sessions'), false);
  assert.equal(tableExists(sqlite, 'ai_messages'), false);

  const piSessionColumns = getColumns(sqlite, 'pi_sessions');
  assert.ok(piSessionColumns.has('agent_id'));
  assert.ok(piSessionColumns.has('channel_id'));
  assert.ok(piSessionColumns.has('channel_session_key'));
  assert.ok(piSessionColumns.has('summary_through_sequence'));

  const piMessageColumns = getColumns(sqlite, 'pi_messages');
  assert.ok(piMessageColumns.has('sequence'));
  const migratedMessages = sqlite.prepare('SELECT id, sequence FROM pi_messages ORDER BY id').all() as Array<{ id: number; sequence: number }>;
  assert.deepEqual(migratedMessages, [
    { id: 10, sequence: 1 },
    { id: 20, sequence: 2 },
  ]);

  const channelActiveSessionColumns = getColumns(sqlite, 'channel_active_sessions');
  assert.ok(channelActiveSessionColumns.has('agent_id'));

  const agentColumns = getColumns(sqlite, 'agents');
  assert.ok(agentColumns.has('icon_id'));
  assert.ok(agentColumns.has('relevant_skills_json'));
  assert.ok(agentColumns.has('relevant_connections_json'));

  const indexes = new Set(
    sqlite.prepare('PRAGMA index_list(channel_active_sessions)').all()
      .map((index) => (index as { name: string }).name),
  );
  assert.ok(indexes.has('idx_channel_active_sessions_user_context_agent'));
  assert.equal(indexes.has('idx_channel_active_sessions_context'), false);
  assert.equal(indexes.has('idx_channel_active_sessions_context_agent'), false);

  const channelLinkIndexes = new Set(
    sqlite.prepare('PRAGMA index_list(session_channel_links)').all()
      .map((index) => (index as { name: string }).name),
  );
  assert.ok(channelLinkIndexes.has('idx_session_channel_links_user_context'));
  const migratedLinks = sqlite.prepare(`
    SELECT session_id AS sessionId, is_primary AS isPrimary
    FROM session_channel_links
    WHERE user_id = 'user-migration'
      AND channel_id = 'web'
      AND channel_session_key = 'web:user:user-migration'
    ORDER BY session_id
  `).all() as Array<{ sessionId: string; isPrimary: number }>;
  assert.deepEqual(migratedLinks, [
    { sessionId: 'sess-migration', isPrimary: 1 },
    { sessionId: 'sess-migration-old', isPrimary: 0 },
  ]);

  const messageIndexes = new Set(
    sqlite.prepare('PRAGMA index_list(pi_messages)').all()
      .map((index) => (index as { name: string }).name),
  );
  assert.ok(messageIndexes.has('idx_pi_messages_session_sequence'));

  sqlite.close();
  console.log('legacy db migration tests passed');
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

function getColumns(sqlite: Database.Database, table: string): Set<string> {
  return new Set(
    sqlite.prepare(`PRAGMA table_info(${table})`).all()
      .map((column) => (column as { name: string }).name),
  );
}

function tableExists(sqlite: Database.Database, table: string): boolean {
  return Boolean(
    sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(table),
  );
}
