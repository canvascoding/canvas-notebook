import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { getFileStats } from '../app/lib/filesystem/workspace-files';
import { documentContentRevision } from '../app/lib/files/document-capabilities';
import type { CurrentFile, FileCollaborationState } from '../app/lib/files/types';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { useFileStore } from '../app/store/file-store';
import { useEditorStore } from '../app/store/editor-store';
import { useWorkspaceStore } from '../app/store/workspace-store';

async function main() {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'notebook-metadata-'));
  try {
    const workspace: WorkspaceContext = { workspaceId: 'metadata-test', workspaceType: 'personal', rootPath, legacy: false,
      permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canCreatePublicLinks: false, canManageWorkspace: false } };
    await writeFile(path.join(rootPath, 'image.png'), 'AAAA');
    await utimes(path.join(rootPath, 'image.png'), 1700000000.1, 1700000000.1);
    const before = await getFileStats('image.png', { workspace });
    await writeFile(path.join(rootPath, 'image.png'), 'BBBB');
    await utimes(path.join(rootPath, 'image.png'), 1700000000.2, 1700000000.2);
    const after = await getFileStats('image.png', { workspace });
    assert.equal(before.size, after.size);
    assert.equal(before.modified, after.modified);
    assert.notEqual(before.fileVersion, after.fileVersion, 'same-size writes within one second have distinct versions');
    const revision = { id: 'persisted-old', contentHash: 'old', baseRevisionId: null, createdAt: 1, createdByActorType: 'user', createdByUserId: null };
    const file: CurrentFile = { path: 'image.png', content: '', stats: before, revision };
    useWorkspaceStore.setState({ activeWorkspaceId: workspace.workspaceId });
    useFileStore.getState().resetWorkspaceView(workspace.workspaceId);
    useFileStore.setState({ currentFile: file, currentFileWorkspaceId: workspace.workspaceId });
    useEditorStore.getState().setActiveFile(file.path, '');
    globalThis.fetch = (async () => Response.json({ success: true, data: { content: '', stats: after, revision } })) as typeof fetch;
    await useFileStore.getState().refreshCurrentFileContent(file.path);
    const refreshed = useFileStore.getState().currentFile;
    assert.notEqual(documentContentRevision(file), documentContentRevision(refreshed), 'a stale persisted revision never masks the new binary file');
    assert.equal(useFileStore.getState().fileRevisions[file.path], after.fileVersion);

    const collaboration: FileCollaborationState = { path: 'live.md', crdtCapable: true, sceneCapable: false,
      strategy: 'crdt_text', lockRequired: false, requiresRevisionCheck: false, latestRevision: revision, activeLock: null, document: null };
    useFileStore.setState({ currentFile: { ...file, path: 'live.md', content: 'live document', collaboration }, currentFileWorkspaceId: workspace.workspaceId });
    useEditorStore.getState().setActiveFile('live.md', 'live document');
    await useFileStore.getState().refreshCurrentFileContent('live.md');
    assert.equal(useFileStore.getState().documentSyncStatus, 'idle', 'metadata refresh must not claim the live document content was updated');
    assert.equal(useFileStore.getState().currentFile?.content, 'live document');
  } finally { await rm(rootPath, { recursive: true, force: true }); }
  console.log('notebook-metadata-revisions-test: ok');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
