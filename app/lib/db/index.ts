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

function createPostgresDatabase() {
  const pool = createPostgresPool();
  return {
    client: pool,
    db: createPostgresDrizzle(pool) as AppDatabase,
  };
}

// The application still exposes the legacy synchronous query helpers through
// its compatibility adapter. Keep that adapter structurally untyped without
// leaking a dialect-specific BetterSQLite3Database surface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AppDatabase = any;

type RuntimeDatabase =
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
  const provider = getDatabaseProvider();
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    const error = new DatabaseUnavailableError(
      'database_initialization_failed',
      'Database connections are disabled during the production build; configure PostgreSQL before starting the runtime.',
      { provider },
    );
    return { client: null, db: createUnavailableDatabase(error), initializationError: error };
  }
  try {
    assertRuntimeDatabaseProviderSupported(provider);
    const database = createPostgresDatabase();
    return { ...database, initializationError: null };
  } catch (error) {
    const unavailableError = coerceDatabaseUnavailableError(error, {
      provider,
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

let runtimeDatabase: RuntimeDatabase | undefined;
function getRuntimeDatabase(): RuntimeDatabase {
  runtimeDatabase ??= createRuntimeDatabase();
  return runtimeDatabase;
}

/**
 * Exposes only query capability from the already-initialized runtime pool.
 * PostgreSQL-only persistence helpers can share the app pool without creating
 * their own connection pool or gaining permission to close the runtime pool.
 */
export function getPostgresRuntimeQueryable(): ReturnType<typeof createPostgresPool> | null {
  const database = getRuntimeDatabase();
  return getDatabaseProvider() === 'postgres' && database.client
    ? database.client as ReturnType<typeof createPostgresPool>
    : null;
}

export const db: AppDatabase = new Proxy(Object.create(null), {
  get(_target, property) {
    return Reflect.get(getRuntimeDatabase().db, property);
  },
  set(_target, property, value) {
    return Reflect.set(getRuntimeDatabase().db, property, value);
  },
}) as AppDatabase;
export { getDatabaseProvider, resolveSqlitePath };

export function getDatabaseInitializationError(): DatabaseUnavailableError | null {
  return getRuntimeDatabase().initializationError;
}

export function assertDatabaseAvailable(): void {
  const database = getRuntimeDatabase();
  if (database.initializationError) {
    throw database.initializationError;
  }
}

export async function ensureDatabaseReady(): Promise<void> {
  assertDatabaseAvailable();
}

function translateSqlitePlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

async function openPostgresDb(): Promise<SqlConnection> {
  await ensureDatabaseReady();
  const pool = getPostgresRuntimeQueryable();
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
  return openPostgresDb();
}

/** Releases the shared runtime pool after isolated scripts and graceful shutdowns. */
export async function closeDatabaseConnections(): Promise<void> {
  const pool = getPostgresRuntimeQueryable();
  await pool?.end();
}
