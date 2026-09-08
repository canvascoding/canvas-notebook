export type DatabaseUnavailableCode =
  | 'postgres_unavailable'
  | 'database_initialization_failed';

export type DatabaseUnavailableContext = {
  provider?: 'postgres';
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

const POSTGRES_UNAVAILABLE_CODES = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  '28P01',
  '3D000',
  '53300',
  '57P01',
  '57P02',
  '57P03',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
]);

const POSTGRES_UNAVAILABLE_MESSAGES = [
  /connection terminated unexpectedly/iu,
  /connection terminated due to connection timeout/iu,
  /connect ECONNREFUSED/iu,
  /database system is starting up/iu,
  /database .* does not exist/iu,
  /password authentication failed/iu,
  /role .* does not exist/iu,
  /timeout expired/iu,
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

export function isPostgresDatabaseUnavailableError(error: unknown): boolean {
  const code = readErrorCode(error);
  if (code && POSTGRES_UNAVAILABLE_CODES.has(code)) return true;

  const message = readErrorMessage(error);
  return POSTGRES_UNAVAILABLE_MESSAGES.some((pattern) => pattern.test(message));
}

export function coerceDatabaseUnavailableError(
  error: unknown,
  context: DatabaseUnavailableContext = {},
): DatabaseUnavailableError | null {
  if (isDatabaseUnavailableError(error)) {
    return error;
  }

  if (isPostgresDatabaseUnavailableError(error)) {
    return new DatabaseUnavailableError(
      'postgres_unavailable',
      'PostgreSQL is unavailable. Check its connection and credentials, then retry.',
      { ...context, provider: 'postgres' },
      error,
    );
  }

  return null;
}

export function databaseUnavailablePublicMessage(error: DatabaseUnavailableError): string {
  if (error.code === 'postgres_unavailable') {
    return 'The PostgreSQL database is unavailable. Check its connection and credentials, then retry.';
  }

  return 'The database is unavailable. Retry after the database has been restored.';
}
