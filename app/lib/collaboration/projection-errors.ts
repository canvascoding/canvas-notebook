import { CollaborationCheckpointValidationError, COLLABORATION_CHECKPOINT_ERROR_CODES as CODES } from './checkpoint-errors';

export type CollaborationProjectionPhase = 'snapshot_validate' | 'receipt_begin' | 'file_write'
  | 'checkpoint_confirm' | 'projection_finalize' | 'receipt_finalize'
  | 'create_observe' | 'create_native' | 'create_effects' | 'publication_authority'
  | 'birth_open' | 'birth_verify' | 'birth_prepare' | 'birth_publish' | 'birth_observe' | 'birth_complete' | 'birth_finalize';
const phases = new Set<unknown>(['snapshot_validate', 'receipt_begin', 'file_write', 'checkpoint_confirm', 'projection_finalize', 'receipt_finalize',
  'create_observe', 'create_native', 'create_effects', 'publication_authority',
  'birth_open', 'birth_verify', 'birth_prepare', 'birth_publish', 'birth_observe', 'birth_complete', 'birth_finalize']);
const nativeCodes = new Set(['ENOENT', 'EACCES', 'ENOSPC', 'EIO', 'EROFS', 'EMFILE', 'ETIMEDOUT', 'ECONNRESET',
  '23502', '23503', '23505', '40001', '40P01', '57014', '53300', '08001', '08006', '57P01', '55P03',
  'MARKDOWN_IMPORT_INVALID_INPUT', 'MARKDOWN_IMPORT_ENCODING_UNSUPPORTED', 'MARKDOWN_IMPORT_RICH_UNAVAILABLE',
  'MARKDOWN_IMPORT_TARGET_CHANGED', 'MARKDOWN_IMPORT_TARGET_NOT_EMPTY', 'MARKDOWN_IMPORT_LIFECYCLE_REQUIRED',
  'MARKDOWN_IMPORT_REQUEST_CONFLICT', 'MARKDOWN_IMPORT_BUSY', 'MARKDOWN_IMPORT_COMMIT_UNCONFIRMED',
  'PRINCIPAL_REQUIRED', 'PRINCIPAL_INVALID', 'PRINCIPAL_BUSY', 'PRINCIPAL_SCOPE_CHANGED', 'PRINCIPAL_AUTH_REVOKED',
  'PRINCIPAL_ACCESS_DENIED', 'PRINCIPAL_WORKSPACE_UNCONFIRMED', 'PRINCIPAL_TOO_LARGE', 'PRINCIPAL_DETACHED',
  'PRINCIPAL_REENTRANT', 'PRINCIPAL_SCHEMA_INVALID', 'PRINCIPAL_EXPIRED', 'COLLABORATION_FILE_LIFECYCLE_BUSY',
  'MARKDOWN_CREATE_BIRTH_ACK_REQUIRED', 'MARKDOWN_CREATE_BIRTH_INVALID_INPUT', 'MARKDOWN_CREATE_BIRTH_MANUAL_PATH_EXISTS',
  'MARKDOWN_CREATE_BIRTH_CLOSED', 'MARKDOWN_CREATE_BIRTH_IO_UNCONFIRMED', 'MARKDOWN_CREATE_BIRTH_NAMESPACE_CHANGED',
  'MARKDOWN_CREATE_BIRTH_OBSERVATION_UNCONFIRMED', 'MARKDOWN_CREATE_BIRTH_RECORD_CHANGED', 'MARKDOWN_CREATE_BIRTH_RECOVERY_REQUIRED',
  'MARKDOWN_CREATE_BIRTH_SOURCE_CHANGED', 'MARKDOWN_CREATE_BIRTH_SOURCE_EXPIRED', 'MARKDOWN_CREATE_BIRTH_TARGET_CHANGED', 'MARKDOWN_CREATE_BIRTH_UNAWAITED_IO']);

export async function inCollaborationProjectionPhase<T>(phase: CollaborationProjectionPhase, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof Error && Object.isExtensible(error)) {
      if (!('collaborationPhase' in error)) Object.defineProperty(error, 'collaborationPhase', { value: phase });
      throw error;
    }
    const wrapped = new Error('Collaboration projection failed.', { cause: error });
    Object.defineProperty(wrapped, 'collaborationPhase', { value: phase });
    throw wrapped;
  }
}

/** Preserve finite native cause codes and phase, never messages, SQL or paths. */
export function classifyCollaborationProjectionError(error: unknown) {
  let code: string = CODES.failed;
  let phase: CollaborationProjectionPhase = 'checkpoint_confirm';
  let causeCode = 'unknown';
  let validationCause: string | undefined;
  // Keep the established bounded breadth-first checkpoint classification:
  // code/permanent control quarantine and retry, rather than diagnostics only.
  const queue: unknown[] = [error];
  for (let count = 0; queue.length && count < 8; count++) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    const candidate = current as { code?: unknown; collaborationPhase?: unknown; cause?: unknown; errors?: unknown[] };
    if (Object.values(CODES).includes(candidate.code as typeof CODES[keyof typeof CODES])) code = candidate.code as string;
    if (current instanceof CollaborationCheckpointValidationError) { code = current.code; validationCause = current.validationCode; }
    if (candidate.cause) queue.push(candidate.cause);
    if (current instanceof AggregateError) queue.push(...current.errors.slice(0, 4));
  }
  // Diagnose the original causal branch only. A later cleanup sibling cannot
  // supply the primary cause or phase, even when the primary code is unknown.
  let primary: unknown = error;
  for (let count = 0; primary && typeof primary === 'object' && count < 8; count++) {
    const candidate = primary as { code?: unknown; collaborationPhase?: unknown; cause?: unknown };
    if (phases.has(candidate.collaborationPhase)) phase = candidate.collaborationPhase as CollaborationProjectionPhase;
    if (causeCode === 'unknown' && nativeCodes.has(candidate.code as string)) causeCode = candidate.code as string;
    primary = candidate.cause ?? (primary instanceof AggregateError ? primary.errors[0] : undefined);
  }
  if (validationCause !== undefined) causeCode = validationCause;
  const permanent = [CODES.schemaInvalid, CODES.stableIdMissing, CODES.stableIdDuplicate, CODES.identityMismatch, CODES.quarantined]
    .includes(code as typeof CODES.schemaInvalid);
  return { code, phase, causeCode, permanent, blocksEditing: permanent };
}
