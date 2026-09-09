import { createPostgresPool, runPostgresMigrations } from './postgres';

export async function runStartupDatabaseMigrations(): Promise<void> {
  console.log('[Startup] Running Postgres database migrations...');
  const migrationPool = createPostgresPool();
  try { await runPostgresMigrations(migrationPool); }
  finally { await migrationPool.end(); }
  console.log('[Startup] Postgres database migrations completed');
}
