import 'server-only';

import path from 'node:path';

import type { CollaborationDocumentRecord } from '@/app/lib/files/collaboration-policy';
import { analyzeMarkdownRichMode } from '@/app/lib/markdown/rich-markdown-codec';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import {
  CollaborationStateInactiveError,
  ensureCollaborationState,
  loadCollaborationStateIncludingArchived,
  type PersistedCollaborationState,
} from './persistence';
import type { TextCollaborationRepresentation } from './types';

const MAX_COLLABORATION_TEXT_BYTES = 5 * 1024 * 1024;

export type ResolvedTextCollaborationState = {
  state: PersistedCollaborationState;
  initialized: boolean;
};

export class CollaborationDocumentStateError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'COLLABORATION_DOCUMENT_MISMATCH'
      | 'COLLABORATION_LIFECYCLE_STALE'
      | 'COLLABORATION_REPRESENTATION_MISMATCH'
      | 'COLLABORATION_TEXT_TOO_LARGE',
  ) {
    super(message);
    this.name = 'CollaborationDocumentStateError';
  }
}

export function selectInitialTextCollaborationRepresentation(
  filePath: string,
  content: string,
): TextCollaborationRepresentation {
  return path.posix.extname(filePath).toLowerCase() === '.txt'
    || analyzeMarkdownRichMode(content).mode !== 'rich'
    ? 'plain_text'
    : 'tiptap_xml';
}

/**
 * Resolves the persisted Yjs identity shared by browser, mobile, and agent
 * actions. File content is used only to initialize a document that has never
 * had Yjs state; an existing or archived state is never rebuilt from a file
 * checkpoint.
 */
export async function resolveTextCollaborationState(input: {
  document: CollaborationDocumentRecord;
  workspace: WorkspaceContext;
  path: string;
  initialRepresentation: TextCollaborationRepresentation;
  initialContent: string;
  requireRepresentationMatch?: boolean;
}): Promise<ResolvedTextCollaborationState> {
  if (
    input.document.status !== 'active'
    || input.document.provider !== 'yjs'
    || input.document.workspaceId !== input.workspace.workspaceId
    || input.document.path !== input.path
  ) {
    throw new CollaborationDocumentStateError(
      'The collaboration document identity does not match the active workspace file.',
      'COLLABORATION_DOCUMENT_MISMATCH',
    );
  }

  const existing = await loadCollaborationStateIncludingArchived(input.document.id);
  if (existing?.status === 'archived') {
    throw new CollaborationDocumentStateError(
      'The collaboration document lifecycle is archived or stale.',
      'COLLABORATION_LIFECYCLE_STALE',
    );
  }
  if (!existing && Buffer.byteLength(input.initialContent, 'utf8') > MAX_COLLABORATION_TEXT_BYTES) {
    throw new CollaborationDocumentStateError(
      'Live collaboration supports text files up to 5 MiB.',
      'COLLABORATION_TEXT_TOO_LARGE',
    );
  }

  const state = existing ?? await ensureCollaborationState({
    documentId: input.document.id,
    workspaceId: input.workspace.workspaceId,
    organizationId: input.workspace.organizationId ?? null,
    path: input.path,
    representation: input.initialRepresentation,
    initialContent: input.initialContent,
  }).catch((error) => {
    if (error instanceof CollaborationStateInactiveError) {
      throw new CollaborationDocumentStateError(
        'The collaboration document lifecycle is archived or stale.',
        'COLLABORATION_LIFECYCLE_STALE',
      );
    }
    throw error;
  });

  if (
    state.workspaceId !== input.workspace.workspaceId
    || state.path !== input.path
    || state.status !== 'active'
  ) {
    throw new CollaborationDocumentStateError(
      'The persisted collaboration state does not match the active workspace file.',
      'COLLABORATION_DOCUMENT_MISMATCH',
    );
  }
  if (input.requireRepresentationMatch && state.representation !== input.initialRepresentation) {
    throw new CollaborationDocumentStateError(
      'The collaboration document representation is stale.',
      'COLLABORATION_REPRESENTATION_MISMATCH',
    );
  }

  return { state, initialized: !existing };
}
