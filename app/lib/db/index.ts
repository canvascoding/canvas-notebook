import {drizzle} from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import {mkdirSync} from 'fs';
import path from 'path';
import * as schema from './schema';
import { runMigrations } from './migrate';
import {
  assertRuntimeDatabaseProviderSupported,
  getDatabaseProvider,
  resolveSqlitePath,
} from './provider';

function getSqlitePath(): string {
  return resolveSqlitePath();
}

const sqlitePath = getSqlitePath();
mkdirSync(path.dirname(sqlitePath), {recursive: true});

const sqlite = new Database(sqlitePath);

// Skip migrations during `next build` — multiple worker processes would race on the same DB file.
// Migrations run at server startup via server.js instead.
if (process.env.NEXT_PHASE !== 'phase-production-build') {
  runMigrations(sqlite);
}

export const db = drizzle(sqlite, {schema});
export { getDatabaseProvider, resolveSqlitePath };

export async function openDb() {
  assertRuntimeDatabaseProviderSupported();
  const freshSqlite = new Database(getSqlitePath());
  const bind = (statement: Database.Statement, params?: unknown[]) => (
    params === undefined ? statement : statement.bind(...params)
  );
  return {
    get: (sql: string, params?: unknown[]) => bind(freshSqlite.prepare(sql), params).get(),
    run: (sql: string, params?: unknown[]) => bind(freshSqlite.prepare(sql), params).run(),
    all: (sql: string, params?: unknown[]) => bind(freshSqlite.prepare(sql), params).all(),
    close: () => freshSqlite.close(),
  };
}
