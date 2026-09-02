import { createRequire } from 'node:module';

import type Database from 'better-sqlite3';
import type { drizzle } from 'drizzle-orm/better-sqlite3';

type BetterSqlite3Constructor = typeof Database;
type BetterSqlite3Module = BetterSqlite3Constructor | { default: BetterSqlite3Constructor };

const runtimeRequire = createRequire(import.meta.url);

export function loadBetterSqlite3(): BetterSqlite3Constructor {
  let loaded: BetterSqlite3Module;
  try {
    loaded = runtimeRequire('better-sqlite3') as BetterSqlite3Module;
  } catch (error) {
    throw new Error(
      'SQLite support is not included in this PostgreSQL-only runtime.',
      { cause: error },
    );
  }
  return typeof loaded === 'function' ? loaded : loaded.default;
}

export function loadDrizzleSqlite(): typeof drizzle {
  const loaded = runtimeRequire('drizzle-orm/better-sqlite3') as { drizzle: typeof drizzle };
  return loaded.drizzle;
}
