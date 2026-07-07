export type DatabaseUnavailableCode =
  | 'sqlite_unreadable'
  | 'database_initialization_failed';

export type DatabaseUnavailableContext = {
  provider?: 'sqlite' | 'postgres';
  sqlitePath?: string;
};

export class DatabaseUnavailableError extends Error {
  readonly cause?: unknown;

  constructor(
    public readonly code: DatabaseUnavailableCode,
    message: string,
    public readonly context: DatabaseUnavailableContext = {},
    cause?: unknown,
  ) {
    super(message);
    this.name = 'DatabaseUnavailableError';
    this.cause = cause;
  }
}

const SQLITE_UNAVAILABLE_CODES = new Set([
  'SQLITE_CANTOPEN',
  'SQLITE_CORRUPT',
  'SQLITE_FULL',
  'SQLITE_IOERR',
  'SQLITE_NOTADB',
  'SQLITE_READONLY',
]);

const SQLITE_UNAVAILABLE_MESSAGES = [
  /database disk image is malformed/iu,
  /file is not a database/iu,
  /malformed database schema/iu,
  /not a database/iu,
  /unable to open database file/iu,
  /attempt to write a readonly database/iu,
  /database or disk is full/iu,
  /disk i\/o error/iu,
];

function readErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isDatabaseUnavailableError(error: unknown): error is DatabaseUnavailableError {
  return error instanceof DatabaseUnavailableError ||
    Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'DatabaseUnavailableError');
}

export function isSqliteDatabaseUnavailableError(error: unknown): boolean {
  const code = readErrorCode(error);
  if (code && SQLITE_UNAVAILABLE_CODES.has(code)) return true;

  const message = readErrorMessage(error);
  return SQLITE_UNAVAILABLE_MESSAGES.some((pattern) => pattern.test(message));
}

export function coerceDatabaseUnavailableError(
  error: unknown,
  context: DatabaseUnavailableContext = {},
): DatabaseUnavailableError | null {
  if (isDatabaseUnavailableError(error)) {
    return error;
  }

  if ((context.provider ?? 'sqlite') === 'sqlite' && isSqliteDatabaseUnavailableError(error)) {
    const location = context.sqlitePath ? ` at ${context.sqlitePath}` : '';
    return new DatabaseUnavailableError(
      'sqlite_unreadable',
      `SQLite database${location} is unavailable or unreadable. Restore it from a backup or replace the database file before retrying.`,
      { ...context, provider: 'sqlite' },
      error,
    );
  }

  return null;
}

export function databaseUnavailablePublicMessage(error: DatabaseUnavailableError): string {
  if (error.code === 'sqlite_unreadable') {
    return 'The SQLite database is unavailable or unreadable. Restore it from a backup or replace the database file before retrying.';
  }

  return 'The database is unavailable. Retry after the database has been restored.';
}
