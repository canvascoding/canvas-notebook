import Database from 'better-sqlite3';
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

  console.log('[Startup] Running database migrations...');
  const databasePath = resolveSqlitePath();
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const migrationDatabase = new Database(databasePath);
  try {
    runMigrations(migrationDatabase);
  } finally {
    migrationDatabase.close();
  }
  console.log('[Startup] Database migrations completed');
}
