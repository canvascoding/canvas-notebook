import Database from 'better-sqlite3';

export class SqliteIntegrityError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SqliteIntegrityError';
    this.cause = cause;
  }
}

function formatSqliteError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function assertSqliteDatabaseReadable(dbPath: string): void {
  let sqlite: InstanceType<typeof Database> | null = null;

  try {
    sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = sqlite.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
    const failures = rows
      .map((row) => String(row.quick_check ?? Object.values(row)[0] ?? 'unknown'))
      .filter((value) => value !== 'ok');

    if (failures.length > 0) {
      throw new SqliteIntegrityError(`SQLite quick_check failed for ${dbPath}: ${failures.join('; ')}`);
    }
  } catch (error) {
    if (error instanceof SqliteIntegrityError) {
      throw error;
    }
    throw new SqliteIntegrityError(
      `SQLite database at ${dbPath} is not readable: ${formatSqliteError(error)}`,
      error,
    );
  } finally {
    sqlite?.close();
  }
}
