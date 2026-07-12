import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import {mkdirSync} from 'fs';
import path from 'path';
import * as schema from './schema';
import { runMigrations } from './migrate';
import {
  createPostgresDrizzle,
  createPostgresPool,
} from './postgres';
import {
  assertRuntimeDatabaseProviderSupported,
  getDatabaseProvider,
  resolveSqlitePath,
} from './provider';
import {
  coerceDatabaseUnavailableError,
  DatabaseUnavailableError,
} from './errors';

export type SqlConnection = {
  get: (sql: string, params?: unknown[]) => unknown | Promise<unknown>;
  run: (sql: string, params?: unknown[]) => unknown | Promise<unknown>;
  all: (sql: string, params?: unknown[]) => unknown[] | Promise<unknown[]>;
  close: () => void | Promise<void>;
};

const provider = getDatabaseProvider();
const shouldRunSqliteStartupMigrations = process.env.NEXT_PHASE !== 'phase-production-build';

function getSqlitePath(): string {
  return resolveSqlitePath();
}

function createSqliteDatabase() {
  const sqlitePath = getSqlitePath();
  mkdirSync(path.dirname(sqlitePath), {recursive: true});

  const sqlite = new Database(sqlitePath);
  if (shouldRunSqliteStartupMigrations) {
    runMigrations(sqlite);
  }
  return {
    client: sqlite,
    db: drizzleSqlite(sqlite, {schema}),
  };
}

function createPostgresDatabase() {
  const pool = createPostgresPool();
  return {
    client: pool,
    db: createPostgresDrizzle(pool),
  };
}

type AppDatabase = ReturnType<typeof createSqliteDatabase>['db'];

type RuntimeDatabase =
  | (ReturnType<typeof createSqliteDatabase> & { initializationError: null })
  | (ReturnType<typeof createPostgresDatabase> & { initializationError: null })
  | { client: null; db: AppDatabase; initializationError: DatabaseUnavailableError };

function createUnavailableDatabase(error: DatabaseUnavailableError): AppDatabase {
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === 'then') return undefined;
      if (property === Symbol.toStringTag) return 'DatabaseUnavailable';
      if (property === 'toJSON') {
        return () => ({
          unavailable: true,
          code: error.code,
          provider: error.context.provider,
        });
      }
      throw error;
    },
    set() {
      throw error;
    },
  }) as AppDatabase;
}

function createRuntimeDatabase(): RuntimeDatabase {
  try {
    const database = provider === 'postgres'
      ? createPostgresDatabase()
      : createSqliteDatabase();
    return { ...database, initializationError: null };
  } catch (error) {
    const unavailableError = coerceDatabaseUnavailableError(error, {
      provider,
      sqlitePath: provider === 'sqlite' ? getSqlitePath() : undefined,
    });
    if (!unavailableError) {
      throw error;
    }

    console.error('[Database] Runtime database unavailable:', unavailableError.message);
    return {
      client: null,
      db: createUnavailableDatabase(unavailableError),
      initializationError: unavailableError,
    };
  }
}

const runtimeDatabase = createRuntimeDatabase();
const postgresPool = provider === 'postgres' && runtimeDatabase.client
  ? runtimeDatabase.client as ReturnType<typeof createPostgresPool>
  : null;

// The app keeps the existing SQLite-table Drizzle types while runtime dialect selection
// happens underneath. The Postgres adapter is intentionally cast to that surface until
// the schema is split into native pgTable definitions.
export const db: AppDatabase = runtimeDatabase.db as AppDatabase;
export { getDatabaseProvider, resolveSqlitePath };

export function getDatabaseInitializationError(): DatabaseUnavailableError | null {
  return runtimeDatabase.initializationError;
}

export function assertDatabaseAvailable(): void {
  if (runtimeDatabase.initializationError) {
    throw runtimeDatabase.initializationError;
  }
}

export async function ensureDatabaseReady(): Promise<void> {
  assertDatabaseAvailable();
}

function bindSqlite(statement: Database.Statement, params?: unknown[]) {
  return params === undefined ? statement : statement.bind(...params);
}

function translateSqlitePlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function runSqliteOperation<T>(sqlitePath: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    const unavailableError = coerceDatabaseUnavailableError(error, {
      provider: 'sqlite',
      sqlitePath,
    });
    if (unavailableError) {
      throw unavailableError;
    }
    throw error;
  }
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
  assertDatabaseAvailable();
  if (provider === 'postgres') {
    return openPostgresDb();
  }

  const sqlitePath = getSqlitePath();
  const freshSqlite = runSqliteOperation(sqlitePath, () => new Database(sqlitePath));
  return {
    get: (sql: string, params?: unknown[]) => runSqliteOperation(
      sqlitePath,
      () => bindSqlite(freshSqlite.prepare(sql), params).get(),
    ),
    run: (sql: string, params?: unknown[]) => runSqliteOperation(
      sqlitePath,
      () => bindSqlite(freshSqlite.prepare(sql), params).run(),
    ),
    all: (sql: string, params?: unknown[]) => runSqliteOperation(
      sqlitePath,
      () => bindSqlite(freshSqlite.prepare(sql), params).all(),
    ),
    close: () => {
      freshSqlite.close();
    },
  };
}
