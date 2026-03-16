import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import * as schema from './schema';

const legacySqlitePath = path.resolve(process.cwd(), 'sqlite.db');
const defaultSqlitePath = existsSync(legacySqlitePath)
  ? legacySqlitePath
  : path.resolve(process.cwd(), 'data', 'sqlite.db');
const sqlitePath = path.resolve(process.env.SQLITE_PATH || defaultSqlitePath);

mkdirSync(path.dirname(sqlitePath), { recursive: true });

const sqlite = new Database(sqlitePath);

// Keep fresh volumes bootable without a separate migration step.
sqlite.exec(`
CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_verified INTEGER NOT NULL,
  image TEXT,
  role TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);

CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS ai_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  ai_session_db_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT,
  attachments TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (ai_session_db_id) REFERENCES ai_sessions(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);

CREATE TABLE IF NOT EXISTS pi_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);

CREATE TABLE IF NOT EXISTS pi_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  pi_session_db_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (pi_session_db_id) REFERENCES pi_sessions(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);

CREATE TABLE IF NOT EXISTS pi_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  fingerprint TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  session_title_snapshot TEXT,
  assistant_timestamp INTEGER NOT NULL,
  stop_reason TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  input_cost REAL NOT NULL,
  output_cost REAL NOT NULL,
  cache_read_cost REAL NOT NULL,
  cache_write_cost REAL NOT NULL,
  total_cost REAL NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);

CREATE TABLE IF NOT EXISTS automation_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  preferred_skill TEXT NOT NULL,
  workspace_context_paths_json TEXT NOT NULL,
  target_output_path TEXT,
  schedule_kind TEXT NOT NULL,
  schedule_config_json TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_run_status TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES user(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  scheduled_for INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  attempt_number INTEGER NOT NULL,
  output_dir TEXT,
  target_output_path TEXT,
  effective_target_output_path TEXT,
  log_path TEXT,
  result_path TEXT,
  error_message TEXT,
  pi_session_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (job_id) REFERENCES automation_jobs(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS user_email_unique ON user (email);
CREATE UNIQUE INDEX IF NOT EXISTS session_token_unique ON session (token);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pi_usage_events_fingerprint ON pi_usage_events (fingerprint);
CREATE INDEX IF NOT EXISTS idx_pi_usage_events_user_created_at ON pi_usage_events (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pi_usage_events_session_created_at ON pi_usage_events (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pi_usage_events_provider_created_at ON pi_usage_events (provider, created_at);
CREATE INDEX IF NOT EXISTS idx_pi_usage_events_model_created_at ON pi_usage_events (model, created_at);
CREATE INDEX IF NOT EXISTS idx_automation_jobs_next_run_at ON automation_jobs (next_run_at);
CREATE INDEX IF NOT EXISTS idx_automation_jobs_status ON automation_jobs (status);
CREATE INDEX IF NOT EXISTS idx_automation_runs_job_id_created_at ON automation_runs (job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs (status);
`);

// Idempotent column additions for existing volumes
const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
const tableNames = new Set(tables.map((t) => t.name));

if (tableNames.has('pi_sessions')) {
  const piSessionColumns = new Set(
    (sqlite.prepare('PRAGMA table_info(pi_sessions)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!piSessionColumns.has('summary_text')) {
    try {
      sqlite.exec('ALTER TABLE pi_sessions ADD COLUMN summary_text TEXT');
    } catch {
      // Column might already exist, ignore
    }
  }
  if (!piSessionColumns.has('summary_updated_at')) {
    try {
      sqlite.exec('ALTER TABLE pi_sessions ADD COLUMN summary_updated_at INTEGER');
    } catch {
      // Column might already exist, ignore
    }
  }
  if (!piSessionColumns.has('summary_through_timestamp')) {
    try {
      sqlite.exec('ALTER TABLE pi_sessions ADD COLUMN summary_through_timestamp INTEGER');
    } catch {
      // Column might already exist, ignore
    }
  }
}

if (tableNames.has('automation_jobs')) {
  const automationJobColumns = new Set(
    (sqlite.prepare('PRAGMA table_info(automation_jobs)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!automationJobColumns.has('target_output_path')) {
    try {
      sqlite.exec('ALTER TABLE automation_jobs ADD COLUMN target_output_path TEXT');
    } catch {
      // Column might already exist, ignore
    }
  }
}

if (tableNames.has('automation_runs')) {
  const automationRunColumns = new Set(
    (sqlite.prepare('PRAGMA table_info(automation_runs)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!automationRunColumns.has('target_output_path')) {
    try {
      sqlite.exec('ALTER TABLE automation_runs ADD COLUMN target_output_path TEXT');
    } catch {
      // Column might already exist, ignore
    }
  }
  if (!automationRunColumns.has('effective_target_output_path')) {
    try {
      sqlite.exec('ALTER TABLE automation_runs ADD COLUMN effective_target_output_path TEXT');
    } catch {
      // Column might already exist, ignore
    }
  }
}

// OAuth tokens table for provider authentication
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    id TEXT PRIMARY KEY NOT NULL,
    provider TEXT NOT NULL,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at INTEGER,
    scope TEXT,
    email TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    is_valid INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON oauth_tokens(provider);
  CREATE INDEX IF NOT EXISTS idx_oauth_tokens_valid ON oauth_tokens(provider, is_valid);
`);

export const db = drizzle(sqlite, { schema });

// Helper function for raw SQLite operations
export async function openDb() {
  const sqlite = new Database(sqlitePath);
  return {
    get: (sql: string, params?: unknown[]) => sqlite.prepare(sql).get(params),
    run: (sql: string, params?: unknown[]) => sqlite.prepare(sql).run(params),
    all: (sql: string, params?: unknown[]) => sqlite.prepare(sql).all(params),
    close: () => sqlite.close(),
  };
}
