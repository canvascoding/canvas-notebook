import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-office-sqlite-'));
  process.env.DATA = root;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.CANVAS_MCP_DIRECT_ENABLED = 'false';
  process.env.BETTER_AUTH_BASE_URL = 'http://localhost:3000';
  try {
    const { createEmptyDocx } = await import('../app/lib/office/empty-docx');
    const { writeWorkspaceFileContent } = await import('../app/lib/files/write-service');
    const policy = await import('../app/lib/files/collaboration-policy');
    const { readOfficeDocumentSnapshot } = await import('../app/lib/office/document-service');
    const workspace: WorkspaceContext = { workspaceId: 'office-sqlite', workspaceType: 'personal', rootPath: path.join(root, 'workspace'), organizationId: null, ownerUserId: 'alice', legacy: false,
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } };
    await fs.mkdir(path.join(workspace.rootPath, 'folder'), { recursive: true });
    const content = await createEmptyDocx();
    const initial = await writeWorkspaceFileContent({ workspace, fileOptions: { workspace }, actorUserId: 'alice', path: 'folder/empty.docx', content, createOnly: true });
    const { lock } = await policy.acquireFileLock({ workspace, path: 'folder/empty.docx', lockedByUserId: 'alice', lockedBySessionId: 'tab-a', baseRevisionId: initial.revision.id });
    await assert.rejects(() => policy.acquireFileLock({ workspace, path: 'folder/empty.docx', lockedByUserId: 'alice', lockedBySessionId: 'tab-b' }), { code: 'FILE_LOCKED' });
    await assert.rejects(() => policy.assertNoActiveOfficeLeases(workspace, ['folder']), { code: 'FILE_LOCKED' });
    const updated = await writeWorkspaceFileContent({ workspace, fileOptions: { workspace }, actorUserId: 'alice', actorSessionId: 'tab-a', path: 'folder/empty.docx', content,
      expectedSha256: initial.stats.sha256, baseRevisionId: initial.revision.id, lockId: lock.id });
    assert.equal(updated.revision.id, initial.revision.id);
    await policy.releaseFileLock({ workspace, lockId: lock.id, actorUserId: 'alice', actorSessionId: 'tab-a' });
    const snapshot = await readOfficeDocumentSnapshot(workspace, 'folder/empty.docx');
    assert.deepEqual(snapshot.content, content);
    await policy.moveFileCollaborationPath({ workspace, oldPath: 'folder', newPath: 'renamed' });
    const moved = await policy.getFileCollaborationState({ workspace, path: 'renamed/empty.docx', ensureDocument: true });
    assert.equal(moved.lineageId, initial.revision.lineageId);
    await policy.archiveFileCollaborationPaths({ workspace, paths: [{ path: 'renamed', trashEntryId: 'trash-example' }] });
    await policy.restoreFileCollaborationPath({ workspace, path: 'renamed', trashEntryId: 'trash-example' });
    const restored = await policy.getFileCollaborationState({ workspace, path: 'renamed/empty.docx', ensureDocument: true });
    assert.equal(restored.lineageId, moved.lineageId);
    assert.equal(restored.latestRevision?.id, moved.latestRevision?.id);
    const { readOfficePathHistory } = await import('../app/lib/office/document-versions');
    // The current path need not exist: restore metadata and old bytes are enough.
    const history = await readOfficePathHistory(workspace, 'renamed/empty.docx');
    assert.equal(history.lineageId, initial.revision.lineageId);
    const recovered = await readOfficePathHistory(workspace, 'renamed/empty.docx', history.lineageId, initial.stats.sha256);
    assert.ok(typeof recovered.content === 'string');
    assert.deepEqual(Buffer.from(recovered.content.slice(7), 'base64'), content);
    await policy.initializeCopiedFileCollaborationPaths({ workspace, paths: ['renamed/empty.docx'] });
    const replacement = await readOfficePathHistory(workspace, 'renamed/empty.docx');
    assert.notEqual(replacement.lineageId, history.lineageId);
    assert.ok(replacement.lineages?.some((lineage) => lineage.id === history.lineageId && lineage.status === 'archived'));
    assert.ok('content' in await readOfficePathHistory(workspace, 'renamed/empty.docx', history.lineageId, initial.stats.sha256));
    await assert.rejects(() => readOfficePathHistory({ ...workspace, workspaceId: 'other-workspace' }, 'renamed/empty.docx', history.lineageId, initial.stats.sha256), { code: 'OFFICE_VERSION_NOT_FOUND' });
    await assert.rejects(() => readOfficePathHistory(workspace, 'unrelated.docx', history.lineageId, initial.stats.sha256), { code: 'OFFICE_VERSION_NOT_FOUND' });
    const { default: Database } = await import('better-sqlite3');
    const { runMigrations } = await import('../app/lib/db/migrate');
    const sqlite = new Database(path.join(root, 'sqlite.db'));
    try { runMigrations(sqlite); runMigrations(sqlite); } finally { sqlite.close(); }
    console.log('PASS SQLite: valid DOCX create/read/save, session lease, descendant guards, lineage rename/archive/restore, repeated migration and scoped archived history without canonical file');
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
