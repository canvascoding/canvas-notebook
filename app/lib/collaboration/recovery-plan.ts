import { createHash } from 'node:crypto';
import type { TextCollaborationRepresentation } from './types';

/** Offline evidence only. No registry inserts, ID rebinding or SQLite fallback. */
export type RecoveryState = {
  documentId: string;
  workspaceId: string;
  organizationId: string | null;
  path: string;
  representation: TextCollaborationRepresentation;
  schemaVersion: number;
  newlineStyle: 'lf' | 'crlf';
  hasBom: boolean;
  lifecycleGeneration: number;
  documentSequence: number;
  checkpointSequence: number;
  stateVector: string;
  yjsHash: string;
  canonicalHash: string | null;
  serializedHash: string | null;
  computedSerializedHash: string | null;
  validationCode: string | null;
  degraded: boolean;
};
export type RecoveryRegistry = {
  id: string;
  workspaceId: string;
  organizationId: string | null;
  path: string;
  provider: string;
  status: string;
  workspaceType: string;
  snapshotRevisionId: string | null;
};
export type RecoveryWorkspace = {
  id: string;
  organizationId: string | null;
  type: string;
  status: string;
  rootRelativePath: string;
};
export type RecoveryFile = { workspaceId: string; path: string; hash: string | null; errorCode: string | null };
export type CollaborationRecoveryEvidence = {
  states: RecoveryState[];
  registry: RecoveryRegistry[];
  workspaces: RecoveryWorkspace[];
  files: RecoveryFile[];
};

export function recoveryHash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function currentIdentity(state: RecoveryState, registry: RecoveryRegistry, workspace?: RecoveryWorkspace): boolean {
  return registry.id === state.documentId && registry.workspaceId === state.workspaceId
    && registry.path === state.path && registry.provider === 'yjs' && registry.status === 'active'
    && registry.organizationId === state.organizationId && workspace?.status === 'active'
    && workspace.organizationId === state.organizationId && workspace.type === registry.workspaceType;
}

export type CollaborationRecoveryCase = {
  documentId: string;
  successorId: string | null;
  scope: 'valid' | 'invalid';
  schema: string;
  fileComparison: 'current' | 'historical' | 'other' | 'unavailable';
  proposedAction: 'retain_current_file' | 'restore_current_snapshot_after_approval' | 'manual_review';
  reason: string;
  /** Recheck all of these under the workspace mutation lock before any repair. */
  preconditions: {
    orphan: RecoveryState;
    successor: RecoveryState | null;
    registry: RecoveryRegistry[];
    workspace: RecoveryWorkspace | null;
    actualFileHash: string | null;
  };
  fingerprint: string;
};

/** Stable, idempotent plan. Never grants historical bytes authority over a successor. */
export function planCollaborationRecovery(evidence: CollaborationRecoveryEvidence) {
  const cases: CollaborationRecoveryCase[] = [];
  for (const orphan of [...evidence.states].sort((a, b) => a.documentId.localeCompare(b.documentId))) {
    const workspace = evidence.workspaces.find((item) => item.id === orphan.workspaceId);
    const identities = evidence.registry.filter((item) => item.workspaceId === orphan.workspaceId && item.path === orphan.path)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (identities.some((item) => currentIdentity(orphan, item, workspace))) continue;
    const active = identities.filter((item) => item.status === 'active');
    const successorRegistry = active.length === 1 && active[0].provider === 'yjs' ? active[0] : null;
    const successor = successorRegistry ? evidence.states.find((item) => item.documentId === successorRegistry.id) ?? null : null;
    const scopeValid = workspace?.status === 'active' && workspace.organizationId === orphan.organizationId
      && Boolean(successor && successorRegistry && currentIdentity(successor, successorRegistry, workspace));
    const file = evidence.files.find((item) => item.workspaceId === orphan.workspaceId && item.path === orphan.path);
    const actualFileHash = file?.hash ?? null;
    const currentHash = successor?.computedSerializedHash;
    const fileComparison = !actualFileHash ? 'unavailable'
      : currentHash && actualFileHash === currentHash ? 'current'
        : orphan.serializedHash && actualFileHash === orphan.serializedHash ? 'historical' : 'other';
    const currentSnapshotVerified = successor && !successor.degraded && !successor.validationCode
      && successor.documentSequence === successor.checkpointSequence && successor.checkpointSequence > 0
      && currentHash && currentHash === successor.serializedHash && Boolean(successorRegistry?.snapshotRevisionId);
    const proposedAction = !scopeValid || !currentSnapshotVerified || !actualFileHash ? 'manual_review'
      : fileComparison === 'current' ? 'retain_current_file'
        : fileComparison === 'historical' ? 'restore_current_snapshot_after_approval' : 'manual_review';
    const reason = !scopeValid ? 'missing_or_conflicting_current_identity_or_scope'
      : !currentSnapshotVerified ? 'current_snapshot_not_verified'
        : !actualFileHash ? 'file_not_verified'
          : fileComparison === 'other' ? 'file_changed_outside_known_checkpoints'
            : fileComparison === 'current' ? 'file_already_matches_current_snapshot' : 'file_matches_historical_checkpoint';
    const preconditions = { orphan, successor, registry: identities, workspace: workspace ?? null, actualFileHash };
    cases.push({ documentId: orphan.documentId, successorId: successorRegistry?.id ?? null,
      scope: scopeValid ? 'valid' : 'invalid', schema: orphan.validationCode ?? 'valid', fileComparison,
      proposedAction, reason, preconditions, fingerprint: recoveryHash(JSON.stringify(preconditions)) });
  }
  return { version: 1 as const, cases, planId: recoveryHash(JSON.stringify(cases.map((item) => item.fingerprint))) };
}

export function verifyCollaborationRecoveryCase(
  planned: CollaborationRecoveryCase,
  current: ReturnType<typeof planCollaborationRecovery>,
): 'unchanged' | 'already_restored' | 'changed' {
  const observed = current.cases.find((item) => item.documentId === planned.documentId);
  if (!observed) return 'changed';
  if (observed.fingerprint === planned.fingerprint) return 'unchanged';
  // Idempotence accepts only the exact planned current snapshot, with every
  // non-file precondition still identical. A new generation is always a conflict.
  const before = { ...planned.preconditions, actualFileHash: null };
  const after = { ...observed.preconditions, actualFileHash: null };
  return planned.proposedAction === 'restore_current_snapshot_after_approval'
    && observed.fileComparison === 'current' && JSON.stringify(before) === JSON.stringify(after)
    ? 'already_restored' : 'changed';
}
