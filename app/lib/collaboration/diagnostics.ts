import { logger } from '@/app/lib/logging';

const log = logger.module('Collaboration');
export type CollaborationDiagnostic = {
  event: 'yjs_persisted' | 'yjs_persistence_failed' | 'projection_completed' | 'projection_failed'
    | 'projection_superseded' | 'projection_recovery_failed' | 'guest_version_failed'
    | 'agent_applied' | 'agent_durable' | 'agent_durability_unconfirmed' | 'agent_audit_failed';
  operationId?: string;
  documentId?: string;
  workspaceId?: string;
  generation?: number;
  documentSequence?: number;
  checkpointSequence?: number;
  durationMs?: number;
  lag?: number;
  attempt?: number;
  code?: string;
};

/** Deliberately excludes document contents, filenames, raw exceptions and tokens. */
export function logCollaborationDiagnostic(level: 'debug' | 'info' | 'warn' | 'error', data: CollaborationDiagnostic): void {
  log[level]({ event: data.event, documentId: data.documentId, workspaceId: data.workspaceId, operationId: data.operationId,
    generation: data.generation, documentSequence: data.documentSequence, checkpointSequence: data.checkpointSequence,
    durationMs: data.durationMs, lag: data.lag, attempt: data.attempt, code: data.code });
}
