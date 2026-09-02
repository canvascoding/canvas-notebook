import 'server-only';

import { invalidateWorkspaceFileViews } from '@/app/lib/api/route-helpers';
import { writeFile } from '@/app/lib/filesystem/workspace-files';
import { ensureFileRevisionForCurrentContent } from '@/app/lib/files/collaboration-policy';
import { getParentDirectory } from '@/app/lib/files/path-utils';
import { getWorkspaceFileRevision } from '@/app/lib/files/revision-guard';
import { EXCALIDRAW_FILE_SOURCE } from '@/app/lib/excalidraw-file';
import { queuePublicSharesAfterWrite } from '@/app/lib/public-sharing/public-file-shares';
import { workspaceFileOptions } from '@/app/lib/workspaces/request';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { loadExcalidrawAsset } from './assets';
import { markExcalidrawCheckpoint, type PersistedExcalidrawScene } from './repository';

export async function serializePortableExcalidrawScene(
  state: PersistedExcalidrawScene,
): Promise<string> {
  const files: Record<string, {
    id: string;
    mimeType: string;
    dataURL: string;
    created: number;
    lastRetrieved: number;
    version: number;
  }> = {};
  for (const metadata of state.assets) {
    const asset = await loadExcalidrawAsset({ workspaceId: state.workspaceId, fileId: metadata.fileId });
    if (!asset) throw new Error(`Excalidraw checkpoint asset is missing: ${metadata.fileId}.`);
    files[metadata.fileId] = {
      id: metadata.fileId,
      mimeType: metadata.mimeType,
      dataURL: `data:${metadata.mimeType};base64,${asset.data.toString('base64')}`,
      created: metadata.createdAt,
      lastRetrieved: Date.now(),
      version: metadata.version,
    };
  }
  return JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: EXCALIDRAW_FILE_SOURCE,
    elements: state.elements,
    appState: state.appState,
    files,
  }, null, 2);
}
export async function materializeExcalidrawCheckpoint(input: {
  state: PersistedExcalidrawScene;
  workspace: WorkspaceContext;
  actorUserId?: string | null;
  actorType?: 'user' | 'agent' | 'system';
  sourceSessionId?: string | null;
}): Promise<{ content: string; revisionId: string }> {
  if (input.state.workspaceId !== input.workspace.workspaceId) throw new Error('Excalidraw checkpoint workspace mismatch.');
  if (input.state.status !== 'active') throw new Error('Archived Excalidraw scenes cannot be checkpointed.');
  const content = await serializePortableExcalidrawScene(input.state);
  if (Buffer.byteLength(content, 'utf8') > 50 * 1024 * 1024) throw new Error('Portable Excalidraw checkpoint exceeds the 50 MiB limit.');
  const fileOptions = workspaceFileOptions(input.workspace);
  await writeFile(input.state.path, content, fileOptions);
  const fileRevision = await getWorkspaceFileRevision(input.state.path, fileOptions);
  if (!fileRevision) throw new Error('Excalidraw checkpoint could not be read after write.');
  const revision = await ensureFileRevisionForCurrentContent({
    workspace: input.workspace,
    path: input.state.path,
    contentHash: fileRevision.sha256,
    sizeBytes: fileRevision.stats.size,
    actorUserId: input.actorUserId ?? null,
    actorType: input.actorType ?? 'system',
    sourceSessionId: input.sourceSessionId ?? null,
  });
  await markExcalidrawCheckpoint({
    documentId: input.state.documentId,
    sceneSequence: input.state.sceneSequence,
    revisionId: revision.id,
  });
  invalidateWorkspaceFileViews({
    fileOptions,
    subtreeDirs: [getParentDirectory(input.state.path)],
    mutations: [{ path: input.state.path, type: 'change' }],
  });
  queuePublicSharesAfterWrite([input.state.path], input.workspace);
  return { content, revisionId: revision.id };
}
