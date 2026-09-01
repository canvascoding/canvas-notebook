import 'server-only';

import { readFile, type WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';
import { getFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import { analyzeMarkdownRichMode } from '@/app/lib/markdown/rich-markdown-codec';
import { importPortableExcalidrawAssets } from '@/app/lib/excalidraw-collaboration/assets';
import {
  ensureExcalidrawScene,
  loadExcalidrawScene,
} from '@/app/lib/excalidraw-collaboration/repository';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import {
  finalizeCollaborationCheckpointProjection,
  materializeCollaborationCheckpoint,
  writeCollaborationCheckpointFile,
} from './checkpoint';
import {
  CollaborationDocumentStateError,
  resolveTextCollaborationState,
  selectInitialTextCollaborationRepresentation,
} from './document-state-service';
import {
  CollaborationRepresentationMigrationError,
  changeCollaborationRepresentation,
  changeCollaborationRepresentationWithSafeMarkdownNormalization,
  loadCollaborationStateIncludingArchived,
} from './persistence';
import { COLLABORATION_SCHEMA_VERSION } from './types';
import type {
  CollaborationPermission,
  CollaborationProvider,
  CollaborationRepresentation,
  TextCollaborationRepresentation,
} from './types';

export class CollaborationSessionError extends Error {
  readonly status: 400 | 404 | 409 | 413;
  readonly code?: 'source_representation_required' | 'representation_mismatch';

  constructor(
    message: string,
    status: CollaborationSessionError['status'],
    code?: CollaborationSessionError['code'],
  ) {
    super(message);
    this.name = 'CollaborationSessionError';
    this.status = status;
    this.code = code;
  }
}

export type CollaborationSessionRequest = {
  path: string;
  representation: 'excalidraw_scene';
  provider: 'excalidraw';
} | {
  path: string;
  representation: TextCollaborationRepresentation | 'auto';
  provider: 'yjs';
};

export type CollaborationSessionGrant = {
  path: string;
  provider: CollaborationProvider;
  representation: CollaborationRepresentation;
  documentId: string;
  documentName: string;
  lifecycleGeneration: number;
  permission: CollaborationPermission;
  documentSequence?: number;
  checkpointSequence?: number;
  stateVector?: string;
};

function extension(path: string): string {
  return path.split('.').pop()?.toLowerCase() || '';
}

export function parseCollaborationSessionRequest(input: {
  path?: unknown;
  representation?: unknown;
  provider?: unknown;
}): CollaborationSessionRequest | null {
  const path = typeof input.path === 'string' ? input.path.trim() : '';
  if (!path) return null;

  const ext = extension(path);
  if (ext === 'excalidraw') {
    return input.representation === 'excalidraw_scene'
      && (input.provider === undefined || input.provider === 'excalidraw')
      ? { path, representation: 'excalidraw_scene', provider: 'excalidraw' }
      : null;
  }
  if (input.provider !== undefined && input.provider !== 'yjs') return null;
  if (ext === 'txt' && (input.representation === 'plain_text' || input.representation === 'auto')) {
    return { path, representation: input.representation, provider: 'yjs' };
  }
  if (
    (ext === 'md' || ext === 'markdown')
    && (
      input.representation === 'auto'
      || input.representation === 'plain_text'
      || input.representation === 'tiptap_xml'
    )
  ) {
    return { path, representation: input.representation, provider: 'yjs' };
  }
  return null;
}

export async function createCollaborationSessionGrant(input: {
  workspace: WorkspaceContext;
  fileOptions: WorkspaceFileOperationOptions;
  request: CollaborationSessionRequest;
}): Promise<CollaborationSessionGrant> {
  const { workspace, fileOptions, request } = input;
  const collaboration = getFileCollaborationState({
    workspace,
    path: request.path,
    ensureDocument: true,
  });
  if ((!collaboration.crdtCapable && !collaboration.sceneCapable) || !collaboration.document) {
    throw new CollaborationSessionError('This file is not eligible for live collaboration.', 409);
  }
  if (collaboration.document.provider !== request.provider) {
    throw new CollaborationSessionError(
      'The collaboration provider does not match the file identity.',
      409,
    );
  }

  let lifecycleGeneration: number;
  if (request.provider === 'excalidraw') {
    let state = await loadExcalidrawScene(collaboration.document.id);
    if (!state) {
      const initialContent = (await readFile(request.path, fileOptions)).toString('utf8');
      const initialAssets = await importPortableExcalidrawAssets({
        workspaceId: workspace.workspaceId,
        content: initialContent,
      });
      state = await ensureExcalidrawScene({
        documentId: collaboration.document.id,
        workspaceId: workspace.workspaceId,
        organizationId: workspace.organizationId ?? null,
        path: collaboration.document.path,
        initialContent,
        initialAssets,
      });
    }
    if (
      state.status !== 'active'
      || state.workspaceId !== workspace.workspaceId
      || state.path !== collaboration.document.path
    ) {
      throw new CollaborationSessionError(
        'The Excalidraw collaboration identity or lifecycle is stale.',
        409,
      );
    }
    lifecycleGeneration = state.lifecycleGeneration;
  } else {
    const initialContent = (await readFile(request.path, fileOptions)).toString('utf8');
    const selectedInitialRepresentation = selectInitialTextCollaborationRepresentation(request.path, initialContent);
    const richModeAnalysis = extension(request.path) === 'txt'
      ? null
      : analyzeMarkdownRichMode(initialContent);
    const selectedTargetRepresentation: TextCollaborationRepresentation = richModeAnalysis
      && richModeAnalysis.mode !== 'source'
      ? 'tiptap_xml'
      : selectedInitialRepresentation;
    const existingState = await loadCollaborationStateIncludingArchived(collaboration.document.id);
    if (
      !existingState
      && request.representation === 'tiptap_xml'
      && selectedTargetRepresentation !== 'tiptap_xml'
    ) {
      throw new CollaborationSessionError(
        'This Markdown document can only collaborate in source mode so its representation is preserved.',
        409,
        'source_representation_required',
      );
    }
    const initialRepresentation: TextCollaborationRepresentation = request.representation === 'auto'
      ? selectedInitialRepresentation
      : request.representation;
    let resolved: Awaited<ReturnType<typeof resolveTextCollaborationState>>;
    try {
      resolved = await resolveTextCollaborationState({
        document: collaboration.document,
        workspace,
        path: collaboration.document.path,
        initialRepresentation,
        initialContent,
      });
      if (
        request.representation === 'auto'
        && resolved.state.representation === 'plain_text'
        && selectedTargetRepresentation === 'tiptap_xml'
      ) {
        try {
          if (richModeAnalysis?.mode === 'normalizable') {
            const migration = await changeCollaborationRepresentationWithSafeMarkdownNormalization({
              documentId: resolved.state.documentId,
              expectedLifecycleGeneration: resolved.state.lifecycleGeneration,
              schemaVersion: COLLABORATION_SCHEMA_VERSION,
              checkpoint: {
                write: ({ state, canonicalContent }) => writeCollaborationCheckpointFile({
                  state,
                  workspace,
                  canonicalContent,
                  actorType: 'system',
                }),
                restore: async ({ state }) => {
                  await materializeCollaborationCheckpoint({
                    state,
                    workspace,
                    actorType: 'system',
                  });
                },
                finalize: ({ state, fileWrite }) => {
                  finalizeCollaborationCheckpointProjection({
                    state,
                    workspace,
                    revisionId: fileWrite.revisionId,
                  });
                },
              },
            });
            resolved = {
              state: migration.state,
              initialized: false,
            };
          } else {
            resolved = {
              state: await changeCollaborationRepresentation({
                documentId: resolved.state.documentId,
                expectedLifecycleGeneration: resolved.state.lifecycleGeneration,
                representation: 'tiptap_xml',
                schemaVersion: COLLABORATION_SCHEMA_VERSION,
              }),
              initialized: false,
            };
          }
        } catch (error) {
          if (!(error instanceof CollaborationRepresentationMigrationError)) throw error;
          // Migration is opportunistic: active clients, pending checkpoints,
          // or a concurrent migration keep the durable representation. A
          // fresh read also adopts the winning lifecycle in a two-client race.
          resolved = await resolveTextCollaborationState({
            document: collaboration.document,
            workspace,
            path: collaboration.document.path,
            initialRepresentation,
            initialContent,
          });
        }
      }
    } catch (error) {
      if (error instanceof CollaborationDocumentStateError) {
        throw new CollaborationSessionError(
          error.message,
          error.code === 'COLLABORATION_TEXT_TOO_LARGE' ? 413 : 409,
        );
      }
      throw error;
    }
    const { state } = resolved;
    // Existing documents own their Yjs representation. A checkpoint can be
    // source-only according to the conservative UI codec after a live agent
    // edit while its validated Y.Doc remains rich text.
    if (!resolved.initialized && request.representation !== 'auto' && state.representation !== request.representation) {
      throw new CollaborationSessionError(
        'The collaboration representation does not match this editor. Reload to use the current document representation.',
        409,
        'representation_mismatch',
      );
    }
    lifecycleGeneration = state.lifecycleGeneration;
    return {
      path: request.path,
      provider: request.provider,
      representation: state.representation,
      documentId: collaboration.document.id,
      documentName: collaboration.document.id,
      lifecycleGeneration,
      permission: workspace.permissions.canWrite ? 'write' : 'read',
      documentSequence: state.documentSequence,
      checkpointSequence: state.checkpointSequence,
      stateVector: Buffer.from(state.stateVector).toString('base64'),
    };
  }

  return {
    ...request,
    documentId: collaboration.document.id,
    documentName: collaboration.document.id,
    lifecycleGeneration,
    permission: workspace.permissions.canWrite ? 'write' : 'read',
  };
}
