import type { CollaborationDiagnostic } from './diagnostics';

export type CollaborationStartupPhase = 'load_state' | 'claim_owner' | 'reload_owner_state'
  | 'validate_owner_state' | 'fence_owner' | 'apply_update' | 'create_document'
  | 'connect_access' | 'connect_state' | 'connect_identity' | 'connect_activity'
  | 'connect_owner' | 'connect_projection' | 'connect_snapshot';

const phases = new Set<string>(['load_state', 'claim_owner', 'reload_owner_state', 'validate_owner_state',
  'fence_owner', 'apply_update', 'create_document', 'connect_access', 'connect_state', 'connect_identity',
  'connect_activity', 'connect_owner', 'connect_projection', 'connect_snapshot']);
const codes = new Set<string>(['ROOM_OWNER_BUSY', 'ROOM_OWNER_LOST', 'ROOM_OWNER_SCOPE_CHANGED', 'ROOM_OWNER_UNAVAILABLE',
  'ROOM_ACTIVITY_BUSY', 'ROOM_ACTIVITY_CLOSED', 'ROOM_ACTIVITY_DRAINING', 'ADMISSION_INVALID_REQUEST',
  'ADMISSION_CONFLICT', 'ADMISSION_SCOPE_CHANGED', 'ADMISSION_REQUEST_CHANGED', 'ADMISSION_RECOVERY_REQUIRED',
  'ADMISSION_STATE_CHANGED', 'COLLABORATION_ACCESS_REVOKED']);
const sqlStates = new Set<string>(['40001', '40P01', '55P03', '57014', '08003', '08006', '57P01', '42P01', '42703']);

function startupCauseCode(error: unknown): string {
  try {
    if (!error || typeof error !== 'object') return 'UNCLASSIFIED';
    const code = Object.getOwnPropertyDescriptor(error, 'code');
    if (code && 'value' in code && typeof code.value === 'string') {
      if (codes.has(code.value)) return code.value;
      if (sqlStates.has(code.value)) return `SQLSTATE_${code.value}`;
    }
    const message = Object.getOwnPropertyDescriptor(error, 'message');
    if (message && 'value' in message) {
      if (message.value === 'Collaboration document was not initialized.') return 'DOCUMENT_UNINITIALIZED';
      if (message.value === 'Collaboration connection is closed.') return 'CONNECTION_CLOSED';
    }
  } catch { /* A hostile exception must not change the original cleanup. */ }
  return 'UNCLASSIFIED';
}

/** No raw exception, dynamic message, stack, path, headers or credentials enter
 * diagnostics. Logging cannot replace the failure or interrupt its cleanup. */
export function reportCollaborationStartupFailure(
  emit: (level: 'warn', diagnostic: CollaborationDiagnostic) => void,
  input: { phase: CollaborationStartupPhase; documentId?: string; generation?: number },
  error: unknown,
): void {
  try {
    emit('warn', {
      event: 'room_startup_failed', code: 'COLLABORATION_STARTUP_FAILED',
      phase: phases.has(input.phase) ? input.phase : 'unknown', causeCode: startupCauseCode(error),
      ...(typeof input.documentId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(input.documentId)
        ? { documentId: input.documentId } : {}),
      ...(Number.isSafeInteger(input.generation) && Number(input.generation) >= 1 ? { generation: input.generation } : {}),
    });
  } catch { /* Preserve the original error and all existing cleanup boundaries. */ }
}
