import type Database from 'better-sqlite3';
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
import { loadBetterSqlite3, loadDrizzleSqlite } from './optional-sqlite';

export type SqlConnection = {
  get: (sql: string, params?: unknown[]) => unknown | Promise<unknown>;
  run: (sql: string, params?: unknown[]) => unknown | Promise<unknown>;
  all: (sql: string, params?: unknown[]) => unknown[] | Promise<unknown[]>;
  close: () => void | Promise<void>;
};

const provider = getDatabaseProvider();
// The custom server applies migrations before it imports long-lived runtime
// modules. Reapplying them from every dynamically loaded Next.js module can
// race with active SQLite connections in development, so only standalone
// scripts retain the on-open migration fallback.
const shouldRunSqliteStartupMigrations =
  process.env.NEXT_PHASE !== 'phase-production-build'
  && process.env.CANVAS_DATABASE_MIGRATIONS_COMPLETED !== 'true';

function getSqlitePath(): string {
  return resolveSqlitePath();
}

function createSqliteDatabase() {
  const BetterSqlite3 = loadBetterSqlite3();
  const drizzleSqlite = loadDrizzleSqlite();
  const sqlitePath = getSqlitePath();
  mkdirSync(path.dirname(sqlitePath), {recursive: true});

  const sqlite = new BetterSqlite3(sqlitePath);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
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

function stripPostgresCasts(sql: string): string {
  return sql.replace(/::[a-zA-Z_][a-zA-Z0-9_]*/g, '');
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
  const runPostgresOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      const unavailableError = coerceDatabaseUnavailableError(error, { provider: 'postgres' });
      if (unavailableError) {
        throw unavailableError;
      }
      throw error;
    }
  };
  const client = await runPostgresOperation(() => pool.connect());
  const query = (sql: string, params?: unknown[]) => runPostgresOperation(
    () => client.query(translateSqlitePlaceholders(sql), params),
  );

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
  const BetterSqlite3 = loadBetterSqlite3();
  const freshSqlite = runSqliteOperation(sqlitePath, () => new BetterSqlite3(sqlitePath));
  freshSqlite.pragma('foreign_keys = ON');
  freshSqlite.pragma('busy_timeout = 5000');
  return {
    get: (sql: string, params?: unknown[]) => runSqliteOperation(
      sqlitePath,
      () => bindSqlite(freshSqlite.prepare(stripPostgresCasts(sql)), params).get(),
    ),
    run: (sql: string, params?: unknown[]) => runSqliteOperation(
      sqlitePath,
      () => bindSqlite(freshSqlite.prepare(stripPostgresCasts(sql)), params).run(),
    ),
    all: (sql: string, params?: unknown[]) => runSqliteOperation(
      sqlitePath,
      () => bindSqlite(freshSqlite.prepare(stripPostgresCasts(sql)), params).all(),
    ),
    close: () => {
      freshSqlite.close();
    },
  };
}

/** Releases the shared runtime pool after isolated scripts and graceful shutdowns. */
export async function closeDatabaseConnections(): Promise<void> {
  await postgresPool?.end();
}
