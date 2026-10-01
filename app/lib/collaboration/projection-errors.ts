import { CollaborationCheckpointValidationError, COLLABORATION_CHECKPOINT_ERROR_CODES as CODES } from './checkpoint-errors';

export type CollaborationProjectionPhase = 'snapshot_validate' | 'receipt_begin' | 'file_write'
  | 'checkpoint_confirm' | 'projection_finalize' | 'receipt_finalize';
const phases = new Set<unknown>(['snapshot_validate', 'receipt_begin', 'file_write', 'checkpoint_confirm', 'projection_finalize', 'receipt_finalize']);
const nativeCodes = new Set(['ENOENT', 'EACCES', 'ENOSPC', 'EIO', 'EROFS', 'EMFILE', 'ETIMEDOUT', 'ECONNRESET',
  '23502', '23503', '23505', '40001', '40P01', '57014', '53300', '08001', '08006', '57P01']);

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
  const queue: unknown[] = [error];
  for (let count = 0; queue.length && count < 8; count++) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    const candidate = current as { code?: unknown; collaborationPhase?: unknown; cause?: unknown; errors?: unknown[] };
    if (phases.has(candidate.collaborationPhase)) phase = candidate.collaborationPhase as CollaborationProjectionPhase;
    if (Object.values(CODES).includes(candidate.code as typeof CODES[keyof typeof CODES])) code = candidate.code as string;
    if (nativeCodes.has(candidate.code as string)) causeCode = candidate.code as string;
    if (current instanceof CollaborationCheckpointValidationError) { code = current.code; causeCode = current.validationCode; }
    if (candidate.cause) queue.push(candidate.cause);
    if (current instanceof AggregateError) queue.push(...current.errors.slice(0, 4));
  }
  const permanent = [CODES.schemaInvalid, CODES.stableIdMissing, CODES.stableIdDuplicate, CODES.identityMismatch, CODES.quarantined]
    .includes(code as typeof CODES.schemaInvalid);
  return { code, phase, causeCode, permanent, blocksEditing: permanent };
}
