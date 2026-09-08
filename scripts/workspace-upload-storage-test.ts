import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-upload-storage-'));
  process.env.DATA = data;
  try {
    const service = await import('../app/lib/files/workspace-upload-service');
    const workspaceFiles = await import('../app/lib/filesystem/workspace-files');
    const workspace = { workspaceId: 'storage-test', workspaceType: 'personal' as const, rootPath: path.join(data, 'workspace'), legacy: false,
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } };
    await fs.mkdir(workspace.rootPath);
    const session = await service.createWorkspaceUploadSession({ userId: 'u', workspace, targetDir: '.',
      files: Array.from({ length: 100 }, (_, index) => ({ path: `f${index}.txt`, size: 1 })) });
    const sessionPath = path.join(data, '.uploads/workspace', session.id, 'session.json');
    const manifest = await fs.readFile(sessionPath, 'utf8');
    const scope = { sessionId: session.id, userId: 'u', workspace };
    await Promise.all(session.files.map((file) => service.writeWorkspaceUploadChunk({ ...scope, fileId: file.id,
      includeFullSession: false, offset: 0, expectedBytes: 1, body: new Blob(['x']).stream() })));
    const uploaded = await service.getWorkspaceUploadSession(scope);
    assert.ok(uploaded.files.every((file) => file.uploadedBytes === 1 && file.status === 'uploaded'), 'concurrent file writes retain every offset');
    assert.equal(await fs.readFile(sessionPath, 'utf8'), manifest, 'chunks never rewrite the manifest');
    await Promise.all(session.files.map((file) => service.completeWorkspaceUploadFile({ ...scope, fileId: file.id, includeFullSession: false,
      commit: ({ sourcePath, file }) => workspaceFiles.replaceWorkspaceFileFromPath(sourcePath, file.targetPath, { workspace }) })));
    const completed = await service.getWorkspaceUploadSession(scope);
    assert.equal(completed.status, 'completed');
    assert.ok(completed.files.every((file) => file.status === 'completed'));
    assert.equal(await fs.readFile(sessionPath, 'utf8'), manifest, 'completion persists only its own file');

    const cancelSession = await service.createWorkspaceUploadSession({ userId: 'u', workspace, targetDir: '.', files: [{ path: 'cancel.txt', size: 0 }] });
    const cancelScope = { ...scope, sessionId: cancelSession.id };
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const completing = service.completeWorkspaceUploadFile({ ...cancelScope, fileId: cancelSession.files[0].id,
      commit: async () => { started(); await held; } });
    await entered;
    let cancelled = false;
    const cancelling = service.cancelWorkspaceUploadSession(cancelScope).then(() => { cancelled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(cancelled, false, 'cancellation waits for a write already committing');
    release();
    await Promise.all([completing, cancelling]);
    await assert.rejects(fs.stat(path.join(data, '.uploads/workspace', cancelSession.id)), { code: 'ENOENT' });
    await assert.rejects(service.getWorkspaceUploadSession(cancelScope), (error: unknown) => error instanceof service.WorkspaceUploadServiceError && error.code === 'UPLOAD_NOT_FOUND');
    console.log('workspace-upload-storage-test: ok');
  } finally { await fs.rm(data, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
