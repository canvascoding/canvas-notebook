import {drizzle} from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import {mkdirSync} from 'fs';
import path from 'path';
import * as schema from './schema';

function getDataDir(): string {
  return process.env.DATA || path.resolve(/*turbopackIgnore: true*/ process.cwd(), 'data');
}

function getSqlitePath(): string {
  return path.join(getDataDir(), 'sqlite.db');
}

// Initialize on first import (lazy evaluation of paths)
const sqlitePath = getSqlitePath();
mkdirSync(path.dirname(sqlitePath), {recursive: true});

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
  summary_text TEXT,
  summary_updated_at INTEGER,
  summary_through_timestamp INTEGER,
  last_message_at INTEGER,
  last_viewed_at INTEGER,
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
CREATE INDEX IF NOT EXISTS idx_pi_usage_events_user_assistant_timestamp ON pi_usage_events (user_id, assistant_timestamp);
CREATE INDEX IF NOT EXISTS idx_pi_usage_events_session_assistant_timestamp ON pi_usage_events (session_id, assistant_timestamp);
CREATE INDEX IF NOT EXISTS idx_pi_usage_events_provider_assistant_timestamp ON pi_usage_events (provider, assistant_timestamp);
CREATE INDEX IF NOT EXISTS idx_pi_usage_events_model_assistant_timestamp ON pi_usage_events (model, assistant_timestamp);
CREATE INDEX IF NOT EXISTS idx_automation_jobs_next_run_at ON automation_jobs (next_run_at);
CREATE INDEX IF NOT EXISTS idx_automation_jobs_status ON automation_jobs (status);
CREATE INDEX IF NOT EXISTS idx_automation_runs_job_id_created_at ON automation_runs (job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs (status);

CREATE TABLE IF NOT EXISTS user_hint_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id TEXT NOT NULL,
  hint_key TEXT NOT NULL,
  page TEXT NOT NULL,
  dismissed INTEGER NOT NULL DEFAULT 0,
  dismissed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);

CREATE TABLE IF NOT EXISTS page_onboarding_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id TEXT NOT NULL,
  page TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);

CREATE TABLE IF NOT EXISTS studio_products (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  thumbnail_path TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);
CREATE INDEX IF NOT EXISTS idx_studio_products_user ON studio_products (user_id);
CREATE INDEX IF NOT EXISTS idx_studio_products_created ON studio_products (created_at);

CREATE TABLE IF NOT EXISTS studio_product_images (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER,
  source_type TEXT NOT NULL,
  source_url TEXT,
  sort_order INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (product_id) REFERENCES studio_products(id) ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_studio_product_images_product ON studio_product_images (product_id);

CREATE TABLE IF NOT EXISTS studio_personas (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  thumbnail_path TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);
CREATE INDEX IF NOT EXISTS idx_studio_personas_user ON studio_personas (user_id);
CREATE INDEX IF NOT EXISTS idx_studio_personas_created ON studio_personas (created_at);

CREATE TABLE IF NOT EXISTS studio_persona_images (
  id TEXT PRIMARY KEY NOT NULL,
  persona_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER,
  source_type TEXT NOT NULL,
  source_url TEXT,
  sort_order INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (persona_id) REFERENCES studio_personas(id) ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_studio_persona_images_persona ON studio_persona_images (persona_id);

CREATE TABLE IF NOT EXISTS studio_styles (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  thumbnail_path TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);
CREATE INDEX IF NOT EXISTS idx_studio_styles_user ON studio_styles (user_id);
CREATE INDEX IF NOT EXISTS idx_studio_styles_created ON studio_styles (created_at);

CREATE TABLE IF NOT EXISTS studio_style_images (
  id TEXT PRIMARY KEY NOT NULL,
  style_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER,
  source_type TEXT NOT NULL,
  source_url TEXT,
  sort_order INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (style_id) REFERENCES studio_styles(id) ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_studio_style_images_style ON studio_style_images (style_id);

CREATE TABLE IF NOT EXISTS studio_presets (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  blocks TEXT NOT NULL,
  preview_image_path TEXT,
  tags TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_studio_presets_user ON studio_presets (user_id);
CREATE INDEX IF NOT EXISTS idx_studio_presets_category ON studio_presets (category);
CREATE INDEX IF NOT EXISTS idx_studio_presets_created ON studio_presets (created_at);

CREATE TABLE IF NOT EXISTS studio_generations (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  prompt TEXT,
  raw_prompt TEXT,
  studio_preset_id TEXT,
  aspect_ratio TEXT NOT NULL DEFAULT '1:1',
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  bulk_job_id TEXT,
  pi_session_id TEXT,
  source_generation_id TEXT,
  metadata TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  FOREIGN KEY (studio_preset_id) REFERENCES studio_presets(id) ON UPDATE NO ACTION ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_studio_generations_user ON studio_generations (user_id);
CREATE INDEX IF NOT EXISTS idx_studio_generations_status ON studio_generations (status);
CREATE INDEX IF NOT EXISTS idx_studio_generations_created ON studio_generations (created_at);

CREATE TABLE IF NOT EXISTS studio_generation_products (
  generation_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  PRIMARY KEY (generation_id, product_id),
  FOREIGN KEY (generation_id) REFERENCES studio_generations(id) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES studio_products(id) ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_gen_products_generation ON studio_generation_products (generation_id);
CREATE INDEX IF NOT EXISTS idx_gen_products_product ON studio_generation_products (product_id);

CREATE TABLE IF NOT EXISTS studio_generation_personas (
  generation_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  PRIMARY KEY (generation_id, persona_id),
  FOREIGN KEY (generation_id) REFERENCES studio_generations(id) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (persona_id) REFERENCES studio_personas(id) ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_gen_personas_generation ON studio_generation_personas (generation_id);
CREATE INDEX IF NOT EXISTS idx_gen_personas_persona ON studio_generation_personas (persona_id);

CREATE TABLE IF NOT EXISTS studio_generation_styles (
  generation_id TEXT NOT NULL,
  style_id TEXT NOT NULL,
  PRIMARY KEY (generation_id, style_id),
  FOREIGN KEY (generation_id) REFERENCES studio_generations(id) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (style_id) REFERENCES studio_styles(id) ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_gen_styles_generation ON studio_generation_styles (generation_id);
CREATE INDEX IF NOT EXISTS idx_gen_styles_style ON studio_generation_styles (style_id);

CREATE TABLE IF NOT EXISTS studio_generation_outputs (
  id TEXT PRIMARY KEY NOT NULL,
  generation_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (generation_id) REFERENCES studio_generations(id) ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_studio_generation_outputs_generation ON studio_generation_outputs (generation_id);

CREATE TABLE IF NOT EXISTS studio_bulk_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT,
  studio_preset_id TEXT,
  additional_prompt TEXT,
  aspect_ratio TEXT NOT NULL DEFAULT '1:1',
  versions_per_product INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  total_line_items INTEGER NOT NULL,
  completed_line_items INTEGER NOT NULL DEFAULT 0,
  failed_line_items INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON UPDATE NO ACTION ON DELETE NO ACTION,
  FOREIGN KEY (studio_preset_id) REFERENCES studio_presets(id) ON UPDATE NO ACTION ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_studio_bulk_jobs_user ON studio_bulk_jobs (user_id);
CREATE INDEX IF NOT EXISTS idx_studio_bulk_jobs_status ON studio_bulk_jobs (status);
CREATE INDEX IF NOT EXISTS idx_studio_bulk_jobs_created ON studio_bulk_jobs (created_at);

CREATE TABLE IF NOT EXISTS studio_bulk_job_line_items (
  id TEXT PRIMARY KEY NOT NULL,
  bulk_job_id TEXT NOT NULL,
  product_id TEXT,
  persona_id TEXT,
  generation_id TEXT,
  status TEXT NOT NULL,
  output_path TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (bulk_job_id) REFERENCES studio_bulk_jobs(id) ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES studio_products(id) ON UPDATE NO ACTION ON DELETE SET NULL,
  FOREIGN KEY (persona_id) REFERENCES studio_personas(id) ON UPDATE NO ACTION ON DELETE SET NULL,
  FOREIGN KEY (generation_id) REFERENCES studio_generations(id) ON UPDATE NO ACTION ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_studio_bulk_job_line_items_bulk_job ON studio_bulk_job_line_items (bulk_job_id);
CREATE INDEX IF NOT EXISTS idx_studio_bulk_job_line_items_status ON studio_bulk_job_line_items (status);

CREATE TABLE IF NOT EXISTS page_onboarding_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id TEXT NOT NULL,
  page TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_hint_state_user_hint ON user_hint_state (user_id, hint_key);
CREATE INDEX IF NOT EXISTS idx_user_hint_state_user_page ON user_hint_state (user_id, page);
CREATE UNIQUE INDEX IF NOT EXISTS idx_page_onboarding_state_user_page ON page_onboarding_state (user_id, page);
CREATE INDEX IF NOT EXISTS idx_page_onboarding_state_user_completed ON page_onboarding_state (user_id, completed);
`);

// Idempotent column additions for existing volumes
const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
  name: string
}>;
const tableNames = new Set(tables.map((t) => t.name));

if (tableNames.has('pi_sessions')) {
  const piSessionColumns = new Set(
    (sqlite.prepare('PRAGMA table_info(pi_sessions)').all() as Array<{name: string}>).map((c) => c.name),
  );
  if (!piSessionColumns.has('last_message_at')) {
    try {
      sqlite.exec('ALTER TABLE pi_sessions ADD COLUMN last_message_at INTEGER');
    } catch {
      // Column might already exist, ignore
    }
  }
  if (!piSessionColumns.has('last_viewed_at')) {
    try {
      sqlite.exec('ALTER TABLE pi_sessions ADD COLUMN last_viewed_at INTEGER');
    } catch {
      // Column might already exist, ignore
    }
  }
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_pi_sessions_last_message ON pi_sessions(last_message_at);');
}

if (tableNames.has('automation_jobs')) {
  const automationJobColumns = new Set(
    (sqlite.prepare('PRAGMA table_info(automation_jobs)').all() as Array<{name: string}>).map((c) => c.name),
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
    (sqlite.prepare('PRAGMA table_info(automation_runs)').all() as Array<{name: string}>).map((c) => c.name),
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
  // New columns for storing metadata in DB instead of files
  if (!automationRunColumns.has('events_log')) {
    try {
      sqlite.exec('ALTER TABLE automation_runs ADD COLUMN events_log TEXT');
    } catch {
      // Column might already exist, ignore
    }
  }
  if (!automationRunColumns.has('metadata_json')) {
    try {
      sqlite.exec('ALTER TABLE automation_runs ADD COLUMN metadata_json TEXT');
    } catch {
      // Column might already exist, ignore
    }
  }
}

// Fix legacy previewImagePath values that were stored without the studio/assets/ prefix
if (tableNames.has('studio_presets')) {
  try {
    sqlite.exec(`
      UPDATE studio_presets
      SET preview_image_path = 'studio/assets/' || preview_image_path
      WHERE preview_image_path IS NOT NULL
        AND preview_image_path NOT LIKE 'studio/assets/%'
    `);
  } catch {
    // Migration may fail if column doesn't exist yet, ignore
  }
}

// Onboarding completion log
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS onboarding_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    completed_at INTEGER NOT NULL,
    completed_by TEXT,
    method TEXT NOT NULL,
    notes TEXT,
    created_at INTEGER NOT NULL
  );
`);

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

export const db = drizzle(sqlite, {schema});

// Helper function for raw SQLite operations
export async function openDb() {
  const freshSqlite = new Database(getSqlitePath());
  return {
    get: (sql: string, params?: unknown[]) => freshSqlite.prepare(sql).get(params),
    run: (sql: string, params?: unknown[]) => freshSqlite.prepare(sql).run(params),
    all: (sql: string, params?: unknown[]) => freshSqlite.prepare(sql).all(params),
    close: () => freshSqlite.close(),
  };
}
