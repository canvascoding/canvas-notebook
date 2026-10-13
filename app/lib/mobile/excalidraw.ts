import 'server-only';

import { createHash } from 'node:crypto';
import path from 'node:path';
import type { WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';
import { getExcalidrawDocument, type ExcalidrawDocumentSnapshot } from '@/app/lib/excalidraw-collaboration/scene-service';
import { serializePortableExcalidrawScene } from '@/app/lib/excalidraw-collaboration/checkpoint';
import { applyExcalidrawSnapshot } from '@/app/lib/excalidraw-collaboration/snapshot-service';
import { validatePortableExcalidrawScene } from '@/app/lib/excalidraw-collaboration/portable-import';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { normalizeMobileFilePath } from './files';

const MAX_MOBILE_EXCALIDRAW_BYTES = 10 * 1024 * 1024;
export const MAX_MOBILE_EXCALIDRAW_REQUEST_BYTES = 2 * MAX_MOBILE_EXCALIDRAW_BYTES + 1024 * 1024;

export type MobileExcalidrawDocument = {
  path: string; name: string; content: string; sha256: string; revisionId: string;
  documentId: string; lifecycleGeneration: number; sceneSequence: number;
  checkpoint: ExcalidrawDocumentSnapshot['checkpoint']; canEdit: boolean;
  editBlockReason: 'READ_ONLY' | 'COLLABORATION_DEGRADED' | null; collaborationActive: boolean;
};

export class MobileExcalidrawError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string,
    public readonly currentSceneSequence: number | null = null) {
    super(message); this.name = 'MobileExcalidrawError';
  }
}

function sha256(content: string): string { return createHash('sha256').update(content, 'utf8').digest('hex'); }

function normalizeExcalidrawPath(value: unknown): string {
  const filePath = normalizeMobileFilePath(value, false);
  if (path.posix.extname(filePath).toLowerCase() !== '.excalidraw') throw new MobileExcalidrawError(
    'The selected file is not an Excalidraw document.', 400, 'INVALID_EXCALIDRAW_PATH');
  return filePath;
}

function parsePortableScene(content: unknown): string {
  if (typeof content !== 'string') throw new MobileExcalidrawError('Excalidraw content is required.', 400, 'INVALID_CONTENT');
  if (Buffer.byteLength(content) > MAX_MOBILE_EXCALIDRAW_BYTES) throw new MobileExcalidrawError(
    'Mobile Excalidraw documents may be at most 10 MiB.', 413, 'DOCUMENT_TOO_LARGE');
  validatePortableExcalidrawScene(content);
  return content;
}

async function mobileSceneContent(scene: ExcalidrawDocumentSnapshot): Promise<string> {
  const portable = JSON.parse(await serializePortableExcalidrawScene(scene));
  // This generation-bound hash protects legacy clients that already return the
  // loaded sha256/revisionId but do not yet send the explicit identity fields.
  return JSON.stringify({ ...portable, canvasDocument: {
    documentId: scene.documentId, lifecycleGeneration: scene.lifecycleGeneration,
  } }, null, 2);
}

async function documentValue(workspace: WorkspaceContext, scene: ExcalidrawDocumentSnapshot): Promise<MobileExcalidrawDocument> {
  const content = await mobileSceneContent(scene);
  if (Buffer.byteLength(content) > MAX_MOBILE_EXCALIDRAW_BYTES) throw new MobileExcalidrawError(
    'Mobile Excalidraw documents may be at most 10 MiB.', 413, 'DOCUMENT_TOO_LARGE');
  const degraded = scene.checkpoint.status === 'failed';
  return { path: scene.path, name: path.posix.basename(scene.path), content, sha256: sha256(content),
    revisionId: scene.checkpointRevisionId ?? '', documentId: scene.documentId,
    lifecycleGeneration: scene.lifecycleGeneration, sceneSequence: scene.sceneSequence, checkpoint: scene.checkpoint,
    canEdit: workspace.permissions.canWrite && !degraded,
    editBlockReason: !workspace.permissions.canWrite ? 'READ_ONLY' : degraded ? 'COLLABORATION_DEGRADED' : null,
    collaborationActive: true };
}

export async function readMobileExcalidrawDocument(input: {
  workspace: WorkspaceContext; fileOptions: WorkspaceFileOperationOptions; path: unknown;
  beforeRead?: () => Promise<WorkspaceContext>;
}): Promise<MobileExcalidrawDocument> {
  return withWorkspaceMutationLock(input.workspace.workspaceId, async () => {
    let workspace = await input.beforeRead?.() ?? input.workspace;
    const scene = await getExcalidrawDocument({ workspace, path: normalizeExcalidrawPath(input.path),
      beforeRead: input.beforeRead ? async () => {
        workspace = await input.beforeRead!();
        return workspace;
      } : undefined });
    return documentValue(workspace, scene);
  });
}

export async function saveMobileExcalidrawDocument(input: {
  workspace: WorkspaceContext; fileOptions: WorkspaceFileOperationOptions;
  actorUserId: string; actorSessionId: string; path: unknown; content: unknown;
  expectedSha256: unknown; baseRevisionId: unknown; baseSceneSequence: unknown;
  documentId?: unknown; lifecycleGeneration?: unknown; beforeApply?: () => Promise<WorkspaceContext>;
}): Promise<MobileExcalidrawDocument> {
  const filePath = normalizeExcalidrawPath(input.path);
  const content = parsePortableScene(input.content);
  return withWorkspaceMutationLock(input.workspace.workspaceId, async () => {
    const workspace = await input.beforeApply?.() ?? input.workspace;
    const scene = await getExcalidrawDocument({ workspace, path: filePath, beforeRead: input.beforeApply });
    if (!Number.isSafeInteger(input.baseSceneSequence) || Number(input.baseSceneSequence) < 0) throw new MobileExcalidrawError(
      'A current Excalidraw scene sequence is required.', 428, 'FILE_REVISION_REQUIRED', scene.sceneSequence);
    if (input.documentId !== undefined || input.lifecycleGeneration !== undefined) {
      if (input.documentId !== scene.documentId || input.lifecycleGeneration !== scene.lifecycleGeneration) throw new MobileExcalidrawError(
        'The drawing identity or lifecycle changed. Read it again.', 409, 'EXCALIDRAW_LIFECYCLE_STALE', scene.sceneSequence);
    } else if (!scene.checkpointRevisionId || input.baseRevisionId !== scene.checkpointRevisionId
      || input.expectedSha256 !== sha256(await mobileSceneContent(scene))) {
      throw new MobileExcalidrawError('A current drawing identity or revision is required. Read it again.', 409,
        'EXCALIDRAW_DOCUMENT_MISMATCH', scene.sceneSequence);
    }
    const updated = await applyExcalidrawSnapshot({ workspace, path: scene.path,
      documentId: scene.documentId, lifecycleGeneration: scene.lifecycleGeneration,
      observedSceneSequence: Number(input.baseSceneSequence), content,
      actor: { userId: input.actorUserId, actorId: `user:${input.actorUserId}`, actorType: 'user', sessionId: input.actorSessionId },
      beforeApply: async () => { await input.beforeApply?.(); } });
    return documentValue(workspace, updated);
  });
}
