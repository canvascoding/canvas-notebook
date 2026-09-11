/** PostgreSQL bigint timestamp columns use Unix epoch milliseconds. */
export function normalizeDatabaseTimestamp(value: number): number {
  return Math.trunc(value);
}

/** Converts a Date to the canonical epoch-milliseconds database representation. */
export function toDatabaseTimestamp(value: Date): number {
  return value.getTime();
}

/** Reads canonical milliseconds. Legacy seconds require the explicit database migration. */
export function fromDatabaseTimestamp(value: number): Date {
  return new Date(normalizeDatabaseTimestamp(value));
}
