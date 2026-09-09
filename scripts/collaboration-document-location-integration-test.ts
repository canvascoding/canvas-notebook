import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCollaborationSessionGrant, parseCollaborationSessionRequest } from '../app/lib/collaboration/session-service';
import { resolveCollaborationDocumentLocation } from '../app/lib/collaboration/document-location';
import { renameWorkspacePath } from '../app/lib/files/rename-service';
import { archiveFileCollaborationPaths, getFileCollaborationState, moveFileCollaborationPath } from '../app/lib/files/collaboration-policy';
import { withWorkspaceMutationLock } from '../app/lib/files/workspace-mutation-lock';
import { loadCollaborationState } from '../app/lib/collaboration/persistence';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function main() {
  assert.equal(process.env.CANVAS_DATABASE_PROVIDER, 'postgres');
  assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/canvas_editor_test_\w+$/u);
  const rootPath = await fs.mkdtemp(path.join(process.env.DATA!, 'document-location-'));
  const workspace: WorkspaceContext = { workspaceId: randomUUID(), workspaceType: 'organization', organizationId: null,
    rootPath, legacy: false, permissions: { canRead: true, canWrite: true, canDelete: true,
      canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } };
  const grant = async (filePath: string) => {
    const request = parseCollaborationSessionRequest({ path: filePath, representation: 'plain_text' });
    assert(request);
    return createCollaborationSessionGrant({ workspace, fileOptions: { workspace }, request });
  };
  try {
    await fs.mkdir(path.join(rootPath, 'folder'));
    await fs.writeFile(path.join(rootPath, 'folder', 'before.txt'), 'AAA\n');
    const metadata = await getFileCollaborationState({ workspace, path: 'folder/before.txt', ensureDocument: true });
    assert(metadata.document);
    assert.equal(await loadCollaborationState(metadata.document.id), null);
    assert.deepEqual(await resolveCollaborationDocumentLocation(workspace.workspaceId, metadata.document.id), {
      workspaceId: workspace.workspaceId, documentId: metadata.document.id, path: 'folder/before.txt',
      lifecycleGeneration: null, representation: null,
    }, 'a known document remains openable when its first session was interrupted');
    assert.equal(await loadCollaborationState(metadata.document.id), null, 'location lookup does not initialize a generation');
    const original = await grant('folder/before.txt');
    assert.equal(original.documentId, metadata.document.id);
    const resolve = () => resolveCollaborationDocumentLocation(workspace.workspaceId, original.documentId);
    assert.equal((await resolve())?.path, 'folder/before.txt');
    assert.equal(await resolveCollaborationDocumentLocation(randomUUID(), original.documentId), null, 'another workspace cannot resolve the ID');
    const before = await loadCollaborationState(original.documentId);
    await renameWorkspacePath({ workspace, oldPath: 'folder', newPath: 'renamed', overwrite: false, fileOptions: { workspace } });
    await renameWorkspacePath({ workspace, oldPath: 'renamed/before.txt', newPath: 'renamed/after.txt', overwrite: false, fileOptions: { workspace } });
    assert.deepEqual(await resolve(), { workspaceId: workspace.workspaceId, documentId: original.documentId,
      path: 'renamed/after.txt', lifecycleGeneration: original.lifecycleGeneration, representation: 'plain_text' });
    const after = await loadCollaborationState(original.documentId);
    assert.deepEqual(after?.yjsState, before?.yjsState, 'renames keep the complete Yjs state');
    assert.equal(after?.documentSequence, before?.documentSequence);
    // Reusing the old filename must not redirect an existing document identity.
    await fs.mkdir(path.join(rootPath, 'folder'));
    await fs.writeFile(path.join(rootPath, 'folder', 'before.txt'), 'Replacement\n');
    const replacement = await grant('folder/before.txt');
    assert.notEqual(replacement.documentId, original.documentId);
    assert.equal((await resolve())?.path, 'renamed/after.txt');

    let release!: () => void;
    let entered!: () => void;
    const enteredGate = new Promise<void>((done) => { entered = done; });
    const releaseGate = new Promise<void>((done) => { release = done; });
    const rollback = withWorkspaceMutationLock(workspace.workspaceId, async () => {
      await moveFileCollaborationPath({ workspace, oldPath: 'renamed/after.txt', newPath: 'temporary.txt' });
      entered(); await releaseGate;
      await moveFileCollaborationPath({ workspace, oldPath: 'temporary.txt', newPath: 'renamed/after.txt' });
    });
    await enteredGate;
    let resolved = false;
    const pending = resolve().then((value) => { resolved = true; return value; });
    try {
      await new Promise((done) => setTimeout(done, 30));
      assert.equal(resolved, false, 'location waits for the in-flight workspace mutation');
    } finally { release(); }
    await rollback;
    assert.equal((await pending)?.path, 'renamed/after.txt', 'an intermediate rolled-back path is never returned');
    await archiveFileCollaborationPaths({ workspace, paths: [{ path: 'renamed/after.txt' }] });
    assert.equal(await resolve(), null, 'an archived identity cannot resolve to a replacement file');
    assert.equal((await resolveCollaborationDocumentLocation(workspace.workspaceId, replacement.documentId))?.path, 'folder/before.txt');
    console.log('Document location: workspace isolation, file/folder rename, reused names, immutable Yjs state, mutation rollback and archive passed.');
  } finally { await fs.rm(rootPath, { recursive: true, force: true }); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
