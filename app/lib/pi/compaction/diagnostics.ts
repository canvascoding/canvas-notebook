import { redactPiCompactionText } from './recovery';

const MAX_DIAGNOSTIC_TEXT_CHARACTERS = 1_200;

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
  knownSecrets: readonly string[] = [],
): Record<string, string | number> {
  if (error instanceof Error) {
    const record = error as Error & { code?: unknown; status?: unknown };
    const diagnostics: Record<string, string | number> = {
      errorName: error.name || 'Error',
      errorMessage: sanitizePiCompactionDiagnosticText(error.message, knownSecrets),
    };
    if (typeof record.code === 'string' || typeof record.code === 'number') {
      diagnostics.errorCode = sanitizePiCompactionDiagnosticText(String(record.code), knownSecrets);
    }
    if (typeof record.status === 'number') diagnostics.errorStatus = record.status;
    return diagnostics;
  }

  if (typeof error === 'string') {
    return {
      errorName: 'NonErrorFailure',
      errorMessage: sanitizePiCompactionDiagnosticText(error, knownSecrets),
    };
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const diagnostics: Record<string, string | number> = {
      errorName: typeof record.name === 'string' ? record.name : 'UnknownError',
    };
    if (typeof record.message === 'string') {
      diagnostics.errorMessage = sanitizePiCompactionDiagnosticText(record.message, knownSecrets);
    }
    if (typeof record.code === 'string' || typeof record.code === 'number') {
      diagnostics.errorCode = sanitizePiCompactionDiagnosticText(String(record.code), knownSecrets);
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
