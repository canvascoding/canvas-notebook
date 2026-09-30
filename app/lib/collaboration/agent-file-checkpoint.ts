import 'server-only';

import { promises as fs } from 'node:fs';

import { readFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import { sha256Buffer } from '@/app/lib/files/revision-guard';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

import type { CollaborationTextSnapshot } from './agent-file-edits';
import { CollaborationCheckpointSupersededError, materializeCollaborationCheckpoint } from './checkpoint';
import { loadCollaborationState } from './persistence';

export class CollaborationFileCheckpointUnavailableError extends Error {
  readonly code = 'COLLABORATION_FILE_CHECKPOINT_UNAVAILABLE';

  constructor(path: string) {
    super(`The live content of ${path} is saved, but its physical file checkpoint could not be confirmed.`);
    this.name = 'CollaborationFileCheckpointUnavailableError';
  }
}

export type ConfirmedCollaborationFileCheckpoint = {
  revisionId: string;
  contentHash: string;
  sizeBytes: number;
  documentSequence: number;
  lifecycleGeneration: number;
};

/** Confirm the snapshot's Yjs sequence reached the current physical file before reporting success. */
export async function confirmCollaborativeFileCheckpoint(input: {
  path: string;
  displayPath?: string;
  fullPath: string;
  documentId: string;
  workspace: WorkspaceContext;
  snapshot: CollaborationTextSnapshot;
  actorSessionId?: string;
  beforeMaterialize?: () => Promise<void>;
  onConfirmed?: (checkpoint: ConfirmedCollaborationFileCheckpoint) => Promise<void>;
}): Promise<ConfirmedCollaborationFileCheckpoint> {
  const deadline = Date.now() + 15_000;
  do {
    try {
      const state = await loadCollaborationState(input.documentId);
      if (!state || state.status !== 'active' || state.workspaceId !== input.workspace.workspaceId
        || state.path !== input.path || state.path !== input.snapshot.path
        || state.lifecycleGeneration !== input.snapshot.lifecycleGeneration
        || state.schemaVersion !== input.snapshot.schemaVersion
        || state.representation !== input.snapshot.representation
        || state.documentSequence < input.snapshot.documentSequence) break;
      if (state.checkpointSequence >= input.snapshot.documentSequence) {
        const projection = await readFileCollaborationState({ workspace: input.workspace, path: state.path });
        if (projection.document?.id === input.documentId
          && projection.document.stateVersion >= input.snapshot.documentSequence
          && projection.document.snapshotRevisionId
          && projection.latestRevision?.id === projection.document.snapshotRevisionId) {
          const file = await fs.readFile(input.fullPath);
          if (sha256Buffer(file) === projection.latestRevision.contentHash) {
            const checkpoint = {
              revisionId: projection.latestRevision.id,
              contentHash: projection.latestRevision.contentHash,
              sizeBytes: file.length,
              documentSequence: projection.document.stateVersion,
              lifecycleGeneration: state.lifecycleGeneration,
            };
            await input.onConfirmed?.(checkpoint);
            return checkpoint;
          }
        }
      }
      if (state.checkpointSequence < state.documentSequence) {
        try {
          await input.beforeMaterialize?.();
          await materializeCollaborationCheckpoint({ state, workspace: input.workspace,
            actorType: 'agent', sourceSessionId: input.actorSessionId });
        } catch (error) {
          if (!(error instanceof CollaborationCheckpointSupersededError)) throw error;
        }
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error
        && error.code === 'MCP_DIRECT_EDIT_AUTHORITY_CHANGED') throw error;
      // A durable Yjs operation does not imply a readable, matching physical file.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new CollaborationFileCheckpointUnavailableError(input.displayPath ?? input.path);
}
