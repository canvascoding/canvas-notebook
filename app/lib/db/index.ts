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

CREATE TABLE IF NOT EXISTS claude_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON UPDATE NO ACTION ON DELETE NO ACTION
);

CREATE TABLE IF NOT EXISTS claude_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  claude_session_db_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT,
  attachments TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (claude_session_db_id) REFERENCES claude_sessions(id) ON UPDATE NO ACTION ON DELETE NO ACTION
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

CREATE UNIQUE INDEX IF NOT EXISTS user_email_unique ON user (email);
CREATE UNIQUE INDEX IF NOT EXISTS session_token_unique ON session (token);
`);

export const db = drizzle(sqlite, { schema });
