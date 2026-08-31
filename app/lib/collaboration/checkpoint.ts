import 'server-only';

import { writeFile } from '@/app/lib/filesystem/workspace-files';
import {
  ensureFileRevisionForCurrentContent,
  markCollaborationDocumentCheckpoint,
} from '@/app/lib/files/collaboration-policy';
import { getWorkspaceFileRevision } from '@/app/lib/files/revision-guard';
import { invalidateWorkspaceFileViews } from '@/app/lib/api/route-helpers';
import { getParentDirectory } from '@/app/lib/files/path-utils';
import { queuePublicSharesAfterWrite } from '@/app/lib/public-sharing/public-file-shares';
import { workspaceFileOptions } from '@/app/lib/workspaces/request';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import {
  markCollaborationCheckpoint,
  loadCollaborationState,
  serializeCanonicalText,
  type PersistedCollaborationState,
} from './persistence';

export class CollaborationCheckpointSupersededError extends Error {
  constructor(readonly documentId: string, readonly sequence: number) {
    super(`Collaboration checkpoint ${documentId}@${sequence} was superseded before confirmation.`);
    this.name = 'CollaborationCheckpointSupersededError';
  }
}

export type CollaborationCheckpointFileWrite = {
  content: string;
  revisionId: string;
  serializedContent: string;
};

export async function writeCollaborationCheckpointFile(input: {
  state: PersistedCollaborationState;
  workspace: WorkspaceContext;
  canonicalContent: string;
  actorUserId?: string | null;
  actorType?: 'user' | 'agent' | 'system';
  sourceSessionId?: string | null;
}): Promise<CollaborationCheckpointFileWrite> {
  if (input.state.workspaceId !== input.workspace.workspaceId) {
    throw new Error('Collaboration checkpoint workspace mismatch.');
  }
  if (Buffer.byteLength(input.canonicalContent, 'utf8') > 5 * 1024 * 1024) {
    throw new Error('Collaboration checkpoint exceeds the 5 MiB text limit.');
  }

  const canonical = input.canonicalContent.replace(/\r\n?/gu, '\n');
  const serialized = serializeCanonicalText(canonical, input.state);
  const fileOptions = workspaceFileOptions(input.workspace);
  await writeFile(input.state.path, serialized, fileOptions);
  const fileRevision = await getWorkspaceFileRevision(input.state.path, fileOptions);
  if (!fileRevision) throw new Error('Collaboration checkpoint could not be read after write.');

  const revision = ensureFileRevisionForCurrentContent({
    workspace: input.workspace,
    path: input.state.path,
    contentHash: fileRevision.sha256,
    sizeBytes: fileRevision.stats.size,
    actorUserId: input.actorUserId ?? null,
    actorType: input.actorType ?? 'system',
    sourceSessionId: input.sourceSessionId ?? null,
  });
  return {
    content: serialized,
    revisionId: revision.id,
    serializedContent: serialized,
  };
}

export function finalizeCollaborationCheckpointProjection(input: {
  state: PersistedCollaborationState;
  workspace: WorkspaceContext;
  revisionId: string;
}): void {
  const projectedDocument = markCollaborationDocumentCheckpoint({
    workspace: input.workspace,
    path: input.state.path,
    documentId: input.state.documentId,
    stateVersion: input.state.checkpointSequence,
    snapshotRevisionId: input.revisionId,
  });
  if (
    !projectedDocument
    || projectedDocument.id !== input.state.documentId
    || projectedDocument.stateVersion !== input.state.checkpointSequence
    || projectedDocument.snapshotRevisionId !== input.revisionId
  ) {
    throw new Error('Collaboration checkpoint could not update the authoritative file projection.');
  }

  const fileOptions = workspaceFileOptions(input.workspace);
  invalidateWorkspaceFileViews({
    fileOptions,
    subtreeDirs: [getParentDirectory(input.state.path)],
    mutations: [{ path: input.state.path, type: 'change' }],
  });
  queuePublicSharesAfterWrite([input.state.path], input.workspace);
}

export async function materializeCollaborationCheckpoint(input: {
  state: PersistedCollaborationState;
  workspace: WorkspaceContext;
  canonicalContent: string;
  actorUserId?: string | null;
  actorType?: 'user' | 'agent' | 'system';
  sourceSessionId?: string | null;
}): Promise<{ content: string; revisionId: string }> {
  if (input.state.workspaceId !== input.workspace.workspaceId) {
    throw new Error('Collaboration checkpoint workspace mismatch.');
  }
  const currentState = await loadCollaborationState(input.state.documentId);
  if (
    !currentState
    || currentState.workspaceId !== input.state.workspaceId
    || currentState.path !== input.state.path
    || currentState.lifecycleGeneration !== input.state.lifecycleGeneration
    || currentState.schemaVersion !== input.state.schemaVersion
    || currentState.documentSequence !== input.state.documentSequence
    || !Buffer.from(currentState.stateVector).equals(Buffer.from(input.state.stateVector))
  ) {
    throw new CollaborationCheckpointSupersededError(
      input.state.documentId,
      input.state.documentSequence,
    );
  }
  const canonical = input.canonicalContent.replace(/\r\n?/gu, '\n');
  const fileWrite = await writeCollaborationCheckpointFile({
    state: input.state,
    workspace: input.workspace,
    canonicalContent: canonical,
    actorUserId: input.actorUserId ?? null,
    actorType: input.actorType ?? 'system',
    sourceSessionId: input.sourceSessionId ?? null,
  });
  const checkpointedState = await markCollaborationCheckpoint({
    documentId: input.state.documentId,
    workspaceId: input.state.workspaceId,
    path: input.state.path,
    lifecycleGeneration: input.state.lifecycleGeneration,
    schemaVersion: input.state.schemaVersion,
    sequence: input.state.documentSequence,
    canonicalContent: canonical,
    serializedContent: fileWrite.serializedContent,
  });
  if (!checkpointedState) {
    throw new CollaborationCheckpointSupersededError(
      input.state.documentId,
      input.state.documentSequence,
    );
  }
  finalizeCollaborationCheckpointProjection({
    state: checkpointedState,
    workspace: input.workspace,
    revisionId: fileWrite.revisionId,
  });
  return { content: fileWrite.content, revisionId: fileWrite.revisionId };
}
