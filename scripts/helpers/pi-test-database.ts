import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import { runPostgresMigrations } from '../../app/lib/db/postgres';
import * as schema from '../../app/lib/db/schema';

// Each test gets a new, in-memory PostgreSQL
// database with the real Canvas schema; no configured DATABASE_URL is opened.
export async function createPiTestDatabase() {
  const postgres = new PGlite();
  try {
    await runPostgresMigrations(postgres as unknown as Parameters<typeof runPostgresMigrations>[0]);
  } catch (error) {
    await postgres.close();
    throw error;
  }
  const db = drizzle(postgres, { schema });
  return {
    db,
    getDatabaseProvider: () => 'postgres',
    getDatabaseInitializationError: () => null,
    assertDatabaseAvailable: () => {},
    ensureDatabaseReady: async () => {},
    getPostgresRuntimeQueryable: () => postgres,
    openDb: async () => ({
      get: async (sql: string, params: unknown[] = []) => (await postgres.query(sql, params)).rows[0],
      all: async (sql: string, params: unknown[] = []) => (await postgres.query(sql, params)).rows,
      run: async (sql: string, params: unknown[] = []) => ({ changes: (await postgres.query(sql, params)).affectedRows ?? 0 }),
      close: async () => {},
    }),
    close: () => postgres.close(),
  };
}
