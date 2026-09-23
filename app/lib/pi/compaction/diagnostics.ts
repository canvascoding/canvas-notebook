import { redactPiCompactionText } from './recovery';

const MAX_DIAGNOSTIC_TEXT_CHARACTERS = 1_200;
const SAFE_OPERATIONAL_ERROR_CODES = new Set([
  'ABORT_ERR',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export type PiCompactionDiagnosticLevel = 'info' | 'warn' | 'error';

export function sanitizePiCompactionDiagnosticText(
  value: string,
  knownSecrets: readonly string[] = [],
): string {
  return redactPiCompactionText(value, knownSecrets)
    .slice(0, MAX_DIAGNOSTIC_TEXT_CHARACTERS);
}

export function getPiCompactionErrorDiagnostics(
  error: unknown,
  _knownSecrets: readonly string[] = [],
): Record<string, string | number> {
  const safeErrorName = (value: unknown, fallback: string): string => {
    const candidate = typeof value === 'string' ? value.trim() : '';
    return new Set([
      'Error', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError',
      'PiSummaryTimeoutError', 'PiCompactionPersistenceConflictError',
    ]).has(candidate) ? candidate : fallback;
  };
  const safeErrorCode = (value: string): string => {
    const candidate = value.trim();
    return SAFE_OPERATIONAL_ERROR_CODES.has(candidate) ? candidate : 'present';
  };
  if (error instanceof Error) {
    const record = error as Error & { code?: unknown; status?: unknown };
    const diagnostics: Record<string, string | number> = {
      // Provider messages frequently echo a prompt, attachment name, or tool
      // input. Attempt telemetry is an operational signal, never a transcript.
      errorName: safeErrorName(error.name, 'ProviderError'),
    };
    if (typeof record.code === 'string' || typeof record.code === 'number') {
      diagnostics.errorCode = typeof record.code === 'number'
        ? record.code
        : safeErrorCode(record.code);
    }
    if (typeof record.status === 'number') diagnostics.errorStatus = record.status;
    return diagnostics;
  }

  if (typeof error === 'string') {
    return {
      errorName: 'NonErrorFailure',
    };
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const diagnostics: Record<string, string | number> = {
      errorName: safeErrorName(record.name, 'UnknownError'),
    };
    if (typeof record.code === 'string' || typeof record.code === 'number') {
      diagnostics.errorCode = typeof record.code === 'number'
        ? record.code
        : safeErrorCode(record.code);
    }
    if (typeof record.status === 'number') diagnostics.errorStatus = record.status;
    return diagnostics;
  }

  return { errorName: 'UnknownError' };
}

export function logPiCompactionDiagnostic(
  level: PiCompactionDiagnosticLevel,
  event: string,
  details: Record<string, unknown>,
): void {
  const line = JSON.stringify({ event, ...details });
  if (level === 'error') {
    console.error('[PI Compaction]', line);
    return;
  }
  if (level === 'warn') {
    console.warn('[PI Compaction]', line);
    return;
  }
  console.info('[PI Compaction]', line);
}
