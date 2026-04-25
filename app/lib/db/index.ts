import {drizzle} from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import {mkdirSync} from 'fs';
import path from 'path';
import * as schema from './schema';
import { runMigrations } from './migrate';

function getDataDir(): string {
  return process.env.DATA || path.resolve(/*turbopackIgnore: true*/ process.cwd(), 'data');
}

function getSqlitePath(): string {
  return path.join(getDataDir(), 'sqlite.db');
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

export async function openDb() {
  const freshSqlite = new Database(getSqlitePath());
  return {
    get: (sql: string, params?: unknown[]) => freshSqlite.prepare(sql).get(params),
    run: (sql: string, params?: unknown[]) => freshSqlite.prepare(sql).run(params),
    all: (sql: string, params?: unknown[]) => freshSqlite.prepare(sql).all(params),
    close: () => freshSqlite.close(),
  };
}
