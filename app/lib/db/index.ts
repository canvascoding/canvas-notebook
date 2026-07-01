import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import {mkdirSync} from 'fs';
import path from 'path';
import * as schema from './schema';
import { runMigrations } from './migrate';
import {
  createPostgresDrizzle,
  createPostgresPool,
  runPostgresMigrations,
} from './postgres';
import {
  assertRuntimeDatabaseProviderSupported,
  getDatabaseProvider,
  resolveSqlitePath,
} from './provider';

type SqlConnection = {
  get: (sql: string, params?: unknown[]) => unknown | Promise<unknown>;
  run: (sql: string, params?: unknown[]) => unknown | Promise<unknown>;
  all: (sql: string, params?: unknown[]) => unknown[] | Promise<unknown[]>;
  close: () => void | Promise<void>;
};

const provider = getDatabaseProvider();
const shouldRunStartupMigrations = process.env.NEXT_PHASE !== 'phase-production-build';
let postgresMigrationPromise: Promise<void> | null = null;

function getSqlitePath(): string {
  return resolveSqlitePath();
}

function createSqliteDatabase() {
  const sqlitePath = getSqlitePath();
  mkdirSync(path.dirname(sqlitePath), {recursive: true});

  const sqlite = new Database(sqlitePath);
  // Skip migrations during `next build` — multiple worker processes would race on the same DB file.
  // Migrations run at server startup via server.js instead.
  if (shouldRunStartupMigrations) {
    runMigrations(sqlite);
  }
  return {
    client: sqlite,
    db: drizzleSqlite(sqlite, {schema}),
  };
}

function createPostgresDatabase() {
  const pool = createPostgresPool();
  if (shouldRunStartupMigrations) {
    postgresMigrationPromise = runPostgresMigrations(pool);
  }
  return {
    client: pool,
    db: createPostgresDrizzle(pool),
  };
}

const runtimeDatabase = provider === 'postgres'
  ? createPostgresDatabase()
  : createSqliteDatabase();
const postgresPool = provider === 'postgres'
  ? runtimeDatabase.client as ReturnType<typeof createPostgresPool>
  : null;

type AppDatabase = ReturnType<typeof createSqliteDatabase>['db'];

// The app keeps the existing SQLite-table Drizzle types while runtime dialect selection
// happens underneath. The Postgres adapter is intentionally cast to that surface until
// the schema is split into native pgTable definitions.
export const db: AppDatabase = runtimeDatabase.db as AppDatabase;
export { getDatabaseProvider, resolveSqlitePath };

export async function ensureDatabaseReady(): Promise<void> {
  if (provider === 'postgres') {
    if (!postgresMigrationPromise && shouldRunStartupMigrations) {
      postgresMigrationPromise = runPostgresMigrations(postgresPool!);
    }
    await postgresMigrationPromise;
  }
}

function bindSqlite(statement: Database.Statement, params?: unknown[]) {
  return params === undefined ? statement : statement.bind(...params);
}

function translateSqlitePlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

async function openPostgresDb(): Promise<SqlConnection> {
  await ensureDatabaseReady();
  const pool = postgresPool;
  if (!pool) {
    throw new Error('Postgres runtime pool is not initialized.');
  }
  const client = await pool.connect();
  const query = (sql: string, params?: unknown[]) => client.query(translateSqlitePlaceholders(sql), params);

  return {
    get: async (sql: string, params?: unknown[]) => {
      const result = await query(sql, params);
      return result.rows[0];
    },
    run: async (sql: string, params?: unknown[]) => {
      const result = await query(sql, params);
      return { changes: result.rowCount ?? 0 };
    },
    all: async (sql: string, params?: unknown[]) => {
      const result = await query(sql, params);
      return result.rows;
    },
    close: () => client.release(),
  };
}

export async function openDb(): Promise<SqlConnection> {
  assertRuntimeDatabaseProviderSupported();
  if (provider === 'postgres') {
    return openPostgresDb();
  }

  const freshSqlite = new Database(getSqlitePath());
  return {
    get: (sql: string, params?: unknown[]) => bindSqlite(freshSqlite.prepare(sql), params).get(),
    run: (sql: string, params?: unknown[]) => bindSqlite(freshSqlite.prepare(sql), params).run(),
    all: (sql: string, params?: unknown[]) => bindSqlite(freshSqlite.prepare(sql), params).all(),
    close: () => {
      freshSqlite.close();
    },
  };
}
