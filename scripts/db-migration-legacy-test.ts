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
  `);

  runMigrations(sqlite);

  const piSessionColumns = getColumns(sqlite, 'pi_sessions');
  assert.ok(piSessionColumns.has('agent_id'));
  assert.ok(piSessionColumns.has('channel_id'));
  assert.ok(piSessionColumns.has('channel_session_key'));

  const channelActiveSessionColumns = getColumns(sqlite, 'channel_active_sessions');
  assert.ok(channelActiveSessionColumns.has('agent_id'));

  const indexes = new Set(
    sqlite.prepare('PRAGMA index_list(channel_active_sessions)').all()
      .map((index) => (index as { name: string }).name),
  );
  assert.ok(indexes.has('idx_channel_active_sessions_context_agent'));
  assert.equal(indexes.has('idx_channel_active_sessions_context'), false);

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
