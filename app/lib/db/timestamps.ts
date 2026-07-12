/** Converts a Date to the epoch-seconds representation used by timestamp columns. */
export function toDatabaseTimestamp(value: Date): number {
  return Math.floor(value.getTime() / 1000);
}
