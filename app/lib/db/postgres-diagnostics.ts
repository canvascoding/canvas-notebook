import { isDatabaseUnavailableError, isPostgresDatabaseUnavailableError } from './errors';

/** Safe, finite log codes; never return a driver's SQL, parameters, URL or message. */
export function postgresFailureCode(error: unknown): string {
  let unavailable = false;
  for (let depth = 0; depth < 5 && error && typeof error === 'object'; depth++) {
    const cause = error as { message?: unknown; cause?: unknown };
    if (cause.message === 'Connection terminated due to connection timeout') return 'postgres_connection_timeout';
    if (cause.message === 'timeout exceeded when trying to connect') return 'postgres_pool_wait_timeout';
    unavailable ||= isDatabaseUnavailableError(error) || isPostgresDatabaseUnavailableError(error);
    error = cause.cause;
  }
  return unavailable ? 'postgres_unavailable' : 'unknown';
}
