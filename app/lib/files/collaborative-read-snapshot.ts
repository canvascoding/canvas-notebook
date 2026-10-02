import 'server-only';

import { authoritativeCollaborationSnapshot } from '../collaboration/checkpoint';
import { CollaborationCheckpointValidationError } from '../collaboration/checkpoint-errors';
import { serializeCanonicalText, type PersistedCollaborationState } from '../collaboration/persistence';
import { isCollaborationStateQuarantined } from '../collaboration/failure';
import type { WorkspaceContext } from '../workspaces/types';
import type { FileCollaborationState } from './collaboration-policy';

/** A projected file can lag behind durable Yjs. Reads must never make it a new version. */
export function collaborativeReadSnapshot(input: {
  workspace: WorkspaceContext;
  collaboration: FileCollaborationState;
  state: PersistedCollaborationState | null;
  allowQuarantinedMetadata?: boolean;
  allowUnprojectableMetadata?: boolean;
}): Buffer | null {
  const { workspace, collaboration, state } = input;
  if (!state) return null; // The document has not joined collaboration yet.
  if (!workspace.permissions.canRead || !collaboration.document
    || collaboration.document.provider !== 'yjs' || collaboration.document.status !== 'active'
    || state.documentId !== collaboration.document.id || state.workspaceId !== workspace.workspaceId
    || state.organizationId !== (workspace.organizationId ?? null) || state.path !== collaboration.path
    || state.status !== 'active') {
    throw Object.assign(new Error('The collaborative document changed or is unavailable. Reload the file.'), { status: 409 });
  }
  if (isCollaborationStateQuarantined(state)) {
    if (input.allowQuarantinedMetadata) return null;
    throw Object.assign(new Error('The collaborative document is quarantined. Open it in the notebook for recovery.'), { status: 409 });
  }
  try {
    const snapshot = authoritativeCollaborationSnapshot(state);
    return Buffer.from(serializeCanonicalText(snapshot.canonicalContent, state), 'utf8');
  } catch (error) {
    // This error is reached only after the persisted vector, schema and stable
    // IDs validate. Bootstrap joins the native document without inventing text.
    if (input.allowUnprojectableMetadata && error instanceof CollaborationCheckpointValidationError
      && error.validationCode === 'roundtrip_unstable') return null;
    throw error;
  }
}
