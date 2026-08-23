import 'server-only';

import { readFile, type WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';
import { getFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import { importPortableExcalidrawAssets } from '@/app/lib/excalidraw-collaboration/assets';
import { analyzeMarkdownRichMode } from '@/app/lib/markdown/rich-markdown-codec';
import {
  ensureExcalidrawScene,
  loadExcalidrawScene,
} from '@/app/lib/excalidraw-collaboration/repository';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import {
  CollaborationDocumentStateError,
  resolveTextCollaborationState,
} from './document-state-service';
import type {
  CollaborationPermission,
  CollaborationProvider,
  CollaborationRepresentation,
} from './types';

export class CollaborationSessionError extends Error {
  readonly status: 400 | 404 | 409 | 413;
  readonly code?: 'source_representation_required';

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
  representation: CollaborationRepresentation;
  provider: CollaborationProvider;
};

export type CollaborationSessionGrant = CollaborationSessionRequest & {
  documentId: string;
  documentName: string;
  lifecycleGeneration: number;
  permission: CollaborationPermission;
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
  if (ext === 'txt' && input.representation === 'plain_text') {
    return { path, representation: 'plain_text', provider: 'yjs' };
  }
  if (
    (ext === 'md' || ext === 'markdown')
    && (input.representation === 'plain_text' || input.representation === 'tiptap_xml')
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
    if (request.representation === 'tiptap_xml' && analyzeMarkdownRichMode(initialContent).mode === 'source') {
      throw new CollaborationSessionError(
        'This Markdown document can only collaborate in source mode so its representation is preserved.',
        409,
        'source_representation_required',
      );
    }
    let state;
    try {
      ({ state } = await resolveTextCollaborationState({
        document: collaboration.document,
        workspace,
        path: collaboration.document.path,
        initialRepresentation: request.representation as 'plain_text' | 'tiptap_xml',
        initialContent,
        requireRepresentationMatch: true,
      }));
    } catch (error) {
      if (error instanceof CollaborationDocumentStateError) {
        throw new CollaborationSessionError(
          error.message,
          error.code === 'COLLABORATION_TEXT_TOO_LARGE' ? 413 : 409,
        );
      }
      throw error;
    }
    lifecycleGeneration = state.lifecycleGeneration;
  }

  return {
    ...request,
    documentId: collaboration.document.id,
    documentName: collaboration.document.id,
    lifecycleGeneration,
    permission: workspace.permissions.canWrite ? 'write' : 'read',
  };
}
