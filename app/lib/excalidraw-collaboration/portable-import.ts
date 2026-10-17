import 'server-only';

import { createReadStream } from 'node:fs';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { normalizeWorkspaceRelativePath } from '@/app/lib/workspaces/path-guard';
import { writeFileIfAbsent } from '@/app/lib/filesystem/workspace-files';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { getFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import { assertPortableExcalidrawAssetBindings, validatePortableExcalidrawAssets } from './assets';
import { EXCALIDRAW_PORTABLE_MAX_BYTES } from './limits';
import { validateExcalidrawElements, validateExcalidrawSceneReferences, validateExcalidrawSceneAssetReferences,
  sharedExcalidrawAppState } from './scene';
import { ExcalidrawDocumentError, getExcalidrawDocument, type ExcalidrawDocumentActor } from './scene-service';
import { assertExcalidrawProviderAvailable } from './provider';
import { withExcalidrawImportPublication } from './publication-context';
import { assertExcalidrawLifecycleAvailable } from './lifecycle-availability';

export function validatePortableExcalidrawScene(content: string) {
  if (Buffer.byteLength(content) > EXCALIDRAW_PORTABLE_MAX_BYTES) {
    throw new ExcalidrawDocumentError('EXCALIDRAW_SCENE_TOO_LARGE', 413, 'Portable Excalidraw files may contain at most 50 MiB.');
  }
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.type !== 'excalidraw'
      || !Array.isArray(parsed.elements)) throw new Error('A portable Excalidraw scene is required.');
    if (parsed.appState !== undefined && (!parsed.appState || typeof parsed.appState !== 'object' || Array.isArray(parsed.appState))) {
      throw new Error('The Excalidraw app state is invalid.');
    }
    const elements = validateExcalidrawElements(parsed.elements, 'scene');
    const assets = validatePortableExcalidrawAssets(content);
    validateExcalidrawSceneReferences(elements);
    validateExcalidrawSceneAssetReferences(elements, assets);
    return { elements, appState: sharedExcalidrawAppState(parsed.appState), assets };
  } catch (error) {
    if (error instanceof ExcalidrawDocumentError) throw error;
    throw new ExcalidrawDocumentError('INVALID_EXCALIDRAW_SCENE', 422,
      error instanceof Error ? error.message : 'The portable Excalidraw scene is invalid.');
  }
}

async function readPortableSource(sourcePath: string): Promise<Buffer> {
  const stream = createReadStream(sourcePath, { end: EXCALIDRAW_PORTABLE_MAX_BYTES });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const part of stream) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += chunk.length;
      if (size > EXCALIDRAW_PORTABLE_MAX_BYTES) throw new ExcalidrawDocumentError('EXCALIDRAW_SCENE_TOO_LARGE', 413,
        'Portable Excalidraw files may contain at most 50 MiB.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } finally { stream.destroy(); }
}

/** Trusted upload/copy publication can create exclusively; it cannot replace any destination. */
export async function importExcalidrawDocumentFile(input: {
  workspace: WorkspaceContext; path: string; actor: ExcalidrawDocumentActor;
  content?: string | Buffer; sourcePath?: string; beforeApply?: () => Promise<void>;
  onFileStaged?: (identity: { dev: string; ino: string }) => Promise<void>;
}) {
  await assertExcalidrawProviderAvailable();
  if (!input.workspace.permissions.canRead || !input.workspace.permissions.canWrite
    || (input.workspace.status !== undefined && input.workspace.status !== 'active')) {
    throw new ExcalidrawDocumentError('EXCALIDRAW_PERMISSION_DENIED', 403, 'Current workspace write permission is required.');
  }
  const path = normalizeWorkspaceRelativePath(input.path);
  if (!path.toLowerCase().endsWith('.excalidraw') || path.split('/').pop() === '.excalidraw') {
    throw new ExcalidrawDocumentError('INVALID_EXCALIDRAW_PATH', 400, 'A named .excalidraw path is required.');
  }
  const bytes = input.content ?? (input.sourcePath ? await readPortableSource(input.sourcePath) : undefined);
  if (bytes === undefined) throw new ExcalidrawDocumentError('INVALID_EXCALIDRAW_SCENE', 400, 'Portable scene content is required.');
  const content = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes;
  const parsed = validatePortableExcalidrawScene(content);
  return withWorkspaceMutationLock(input.workspace.workspaceId, async () => {
    await input.beforeApply?.();
    await assertExcalidrawLifecycleAvailable(input.workspace.workspaceId, path);
    const existing = await getFileCollaborationState({ workspace: input.workspace, path, ensureDocument: false });
    if (existing.document?.status === 'active') throw new ExcalidrawDocumentError('PATH_EXISTS', 409,
      'This path already belongs to an Excalidraw document. Restore its checkpoint or choose another path.');
    await assertPortableExcalidrawAssetBindings(input.workspace.workspaceId, parsed.assets);
    try {
      await withExcalidrawImportPublication(input.workspace.workspaceId, path, () =>
        writeFileIfAbsent(path, bytes, { workspace: input.workspace, mutationActorUserId: input.actor.userId },
          input.beforeApply, input.onFileStaged));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ExcalidrawDocumentError('PATH_EXISTS', 409,
        'An existing file cannot be replaced by an Excalidraw upload or copy. Choose another path.');
      throw error;
    }
    return getExcalidrawDocument({ workspace: input.workspace, path, actor: input.actor });
  });
}
