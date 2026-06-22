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
      agent_id TEXT NOT NULL DEFAULT 'canvas-agent',
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

    CREATE TABLE pi_usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      fingerprint TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      message_id TEXT NOT NULL,
      assistant_timestamp TEXT NOT NULL,
      session_title_snapshot TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER NOT NULL,
      stop_reason TEXT,
      input_cost REAL NOT NULL,
      output_cost REAL NOT NULL,
      cache_read_cost REAL NOT NULL,
      cache_write_cost REAL NOT NULL,
      total_cost REAL NOT NULL,
      created_at INTEGER NOT NULL
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

    INSERT INTO pi_sessions (id, session_id, user_id, provider, model, agent_id, title, created_at, updated_at)
    VALUES
      (1, 'sess-migration', 'user-migration', 'test-provider', 'test-model', 'agent-legacy', 'Migration Session', 1700000000, 1700000000),
      (2, 'sess-migration-old', 'user-migration', 'test-provider', 'test-model', 'canvas-agent', 'Old Migration Session', 1699990000, 1699990000);

    INSERT INTO pi_messages (id, pi_session_db_id, role, content, timestamp)
    VALUES
      (10, 1, 'user', '{"role":"user","content":"first","timestamp":2000}', 2000),
      (20, 1, 'user', '{"role":"user","content":"second","timestamp":1000}', 1000);

    INSERT INTO pi_usage_events (
      id,
      fingerprint,
      user_id,
      session_id,
      provider,
      model,
      message_id,
      assistant_timestamp,
      session_title_snapshot,
      input_tokens,
      output_tokens,
      total_tokens,
      cache_read_tokens,
      cache_write_tokens,
      reasoning_tokens,
      stop_reason,
      input_cost,
      output_cost,
      cache_read_cost,
      cache_write_cost,
      total_cost,
      created_at
    )
    VALUES (
      1,
      'legacy-fingerprint',
      'user-migration',
      'sess-migration',
      'test-provider',
      'test-model',
      'msg-legacy',
      '2026-01-01T00:00:00.000Z',
      'Migration Session',
      10,
      20,
      30,
      0,
      0,
      0,
      NULL,
      0.01,
      0.02,
      0,
      0,
      0.03,
      1700000000
    );

    INSERT INTO channel_active_sessions (user_id, channel_id, channel_session_key, channel_thread_key, session_id, updated_at)
    VALUES ('user-migration', 'web', 'web:user:user-migration', '', 'sess-migration', 1700000100);

    CREATE TABLE automation_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt TEXT NOT NULL,
      preferred_skill TEXT NOT NULL,
      workspace_context_paths_json TEXT NOT NULL,
      schedule_kind TEXT NOT NULL,
      schedule_config_json TEXT NOT NULL,
      time_zone TEXT NOT NULL,
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_run_status TEXT,
      created_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE automation_runs (
      id TEXT PRIMARY KEY NOT NULL,
      job_id TEXT NOT NULL,
      status TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      scheduled_for INTEGER,
      started_at INTEGER,
      finished_at INTEGER,
      attempt_number INTEGER NOT NULL,
      output_dir TEXT,
      log_path TEXT,
      result_path TEXT,
      error_message TEXT,
      pi_session_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE knowledge_sources (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT,
      workspace_id TEXT,
      user_id TEXT,
      knowledge_store TEXT NOT NULL,
      source_path TEXT NOT NULL,
      content_hash TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE knowledge_chunks (
      id TEXT PRIMARY KEY NOT NULL,
      source_id TEXT NOT NULL,
      organization_id TEXT,
      workspace_id TEXT,
      user_id TEXT,
      knowledge_store TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content_hash TEXT,
      policy_decision TEXT,
      scan_status TEXT,
      embedding_index_status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT,
      workspace_id TEXT,
      user_id TEXT,
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE public_file_shares (
      id TEXT PRIMARY KEY NOT NULL,
      token_hash TEXT NOT NULL,
      token TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
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

  const migratedUsage = sqlite.prepare(`
    SELECT agent_id AS agentId, organization_id AS organizationId, workspace_id AS workspaceId, workspace_type AS workspaceType
    FROM pi_usage_events
    WHERE id = 1
  `).get() as {
    agentId: string;
    organizationId: string | null;
    workspaceId: string | null;
    workspaceType: string | null;
  };
  assert.equal(migratedUsage.agentId, 'agent-legacy');
  assert.equal(migratedUsage.organizationId, null);
  assert.equal(migratedUsage.workspaceId, null);
  assert.equal(migratedUsage.workspaceType, null);

  const automationJobColumns = getColumns(sqlite, 'automation_jobs');
  assert.ok(automationJobColumns.has('owner_user_id'));
  assert.ok(automationJobColumns.has('scope'));
  assert.ok(automationJobColumns.has('organization_id'));
  assert.ok(automationJobColumns.has('workspace_id'));
  assert.ok(automationJobColumns.has('project_id'));
  assert.ok(indexExists(sqlite, 'automation_jobs', 'idx_automation_jobs_owner_scope'));
  assert.ok(indexExists(sqlite, 'automation_jobs', 'idx_automation_jobs_org_workspace'));
  assert.ok(indexExists(sqlite, 'automation_jobs', 'idx_automation_jobs_project_status'));

  const automationRunColumns = getColumns(sqlite, 'automation_runs');
  assert.ok(automationRunColumns.has('workspace_id'));
  assert.ok(automationRunColumns.has('project_id'));
  assert.ok(automationRunColumns.has('job_scope'));
  assert.ok(indexExists(sqlite, 'automation_runs', 'idx_automation_runs_workspace_created'));
  assert.ok(indexExists(sqlite, 'automation_runs', 'idx_automation_runs_project_created'));

  const knowledgeSourceColumns = getColumns(sqlite, 'knowledge_sources');
  assert.ok(knowledgeSourceColumns.has('project_id'));
  assert.ok(indexExists(sqlite, 'knowledge_sources', 'idx_knowledge_sources_project_store'));

  const knowledgeChunkColumns = getColumns(sqlite, 'knowledge_chunks');
  assert.ok(knowledgeChunkColumns.has('project_id'));
  assert.ok(indexExists(sqlite, 'knowledge_chunks', 'idx_knowledge_chunks_project_store'));

  const auditEventColumns = getColumns(sqlite, 'audit_events');
  assert.ok(auditEventColumns.has('project_id'));
  assert.ok(indexExists(sqlite, 'audit_events', 'idx_audit_events_project_created'));

  const publicShareColumns = getColumns(sqlite, 'public_file_shares');
  assert.ok(publicShareColumns.has('organization_id'));
  assert.ok(publicShareColumns.has('project_id'));
  assert.ok(publicShareColumns.has('short_code'));
  assert.ok(indexExists(sqlite, 'public_file_shares', 'idx_public_file_shares_project_status'));

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

function indexExists(sqlite: Database.Database, table: string, indexName: string): boolean {
  return sqlite.prepare(`PRAGMA index_list(${table})`).all()
    .some((index) => (index as { name: string }).name === indexName);
}
