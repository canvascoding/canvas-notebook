/** Converts a Date to the canonical epoch-milliseconds representation used by PostgreSQL timestamp columns. */
export function toDatabaseTimestamp(value: Date): number {
  return value.getTime();
}
