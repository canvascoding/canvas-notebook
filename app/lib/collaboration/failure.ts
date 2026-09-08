import { COLLABORATION_CHECKPOINT_ERROR_CODES, isCollaborationCheckpointValidationErrorCode } from './checkpoint-errors';

export const COLLABORATION_FAILURE_CODES = {
  generationChanged: 'COLLABORATION_GENERATION_CHANGED',
  persistenceFailed: 'COLLABORATION_YJS_PERSISTENCE_FAILED',
  authenticationFailed: 'COLLABORATION_AUTHENTICATION_FAILED',
  startupFailed: 'COLLABORATION_STARTUP_FAILED',
} as const;

export type CollaborationFailure = {
  kind: 'validation' | 'storage' | 'lifecycle' | 'authentication' | 'startup' | 'unknown';
  code: string | null;
};

/** Unknown/legacy messages never authorize a structure correction. */
export function collaborationFailure(code: unknown): CollaborationFailure {
  if (typeof code !== 'string') return { kind: 'unknown', code: null };
  if (isCollaborationCheckpointValidationErrorCode(code)) return { kind: 'validation', code };
  if (code === COLLABORATION_CHECKPOINT_ERROR_CODES.failed || code === COLLABORATION_FAILURE_CODES.persistenceFailed) {
    return { kind: 'storage', code };
  }
  if (code === COLLABORATION_FAILURE_CODES.generationChanged) return { kind: 'lifecycle', code };
  if (code === COLLABORATION_FAILURE_CODES.authenticationFailed) return { kind: 'authentication', code };
  if (code === COLLABORATION_FAILURE_CODES.startupFailed) return { kind: 'startup', code };
  return { kind: 'unknown', code: null };
}
