/**
 * PostgreSQL bigint timestamp columns use Unix epoch milliseconds.
 *
 * Some pre-PostgreSQL SQLite exports stored epoch seconds. Restrict the
 * compatibility conversion to plausible modern epoch-second values so a
 * legitimate millisecond timestamp close to 1970 is never scaled again.
 */
const LEGACY_EPOCH_SECONDS_MIN = 1_000_000_000; // 2001-09-09T01:46:40.000Z
const LEGACY_EPOCH_SECONDS_MAX = 9_999_999_999; // safely before epoch milliseconds

export function normalizeDatabaseTimestamp(value: number): number {
  const timestamp = Math.trunc(value);
  return timestamp >= LEGACY_EPOCH_SECONDS_MIN && timestamp <= LEGACY_EPOCH_SECONDS_MAX
    ? timestamp * 1_000
    : timestamp;
}

/** Converts a Date to the canonical epoch-milliseconds database representation. */
export function toDatabaseTimestamp(value: Date): number {
  return value.getTime();
}

/** Reads canonical milliseconds while accepting legacy epoch-second values during migration. */
export function fromDatabaseTimestamp(value: number): Date {
  return new Date(normalizeDatabaseTimestamp(value));
}
