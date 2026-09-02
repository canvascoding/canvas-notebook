import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { runMigrations } from './migrate';
import {
  createPostgresPool,
  runPostgresMigrations,
} from './postgres';
import {
  getDatabaseProvider,
  resolveSqlitePath,
} from './provider';
import { loadBetterSqlite3 } from './optional-sqlite';

function runSqliteBootstrapMigrations(): void {
  const BetterSqlite3 = loadBetterSqlite3();
  const databasePath = resolveSqlitePath();
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const migrationDatabase = new BetterSqlite3(databasePath);
  try {
    migrationDatabase.pragma('foreign_keys = ON');
    migrationDatabase.pragma('busy_timeout = 5000');
    runMigrations(migrationDatabase);
    // The server has not opened its long-lived SQLite connections yet. Checkpointing
    // here clears stale WAL state left behind by an interrupted local process, while
    // a busy checkpoint remains non-fatal for shared or managed deployments.
    migrationDatabase.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    migrationDatabase.close();
  }
}

export async function runStartupDatabaseMigrations(): Promise<void> {
  if (getDatabaseProvider() === 'postgres') {
    console.log('[Startup] Running Postgres database migrations...');
    const migrationPool = createPostgresPool();
    try {
      await runPostgresMigrations(migrationPool);
    } finally {
      await migrationPool.end();
    }
    console.log('[Startup] Postgres database migrations completed');
    return;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Production database migrations require PostgreSQL; SQLite is not supported.');
  }

  console.log('[Startup] Running database migrations...');
  runSqliteBootstrapMigrations();
  console.log('[Startup] Database migrations completed');
}
