import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-upload-folders-'));
  process.env.DATA = data;
  try {
    const { createWorkspaceUploadDirectories } = await import('../app/lib/filesystem/upload-directories');
    const workspace = { workspaceId: 'folders-test', workspaceType: 'personal' as const, rootPath: path.join(data, 'workspace'), legacy: false,
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } };
    await fs.mkdir(workspace.rootPath);
    const first = await createWorkspaceUploadDirectories(workspace, '.', ['root/empty', 'root/deep/empty']);
    assert.equal(first.completed.length, 2);
    assert.equal(first.failed.length, 0);
    assert.deepEqual(await fs.readdir(path.join(workspace.rootPath, 'root/deep/empty')), []);
    assert.equal(first.completed[0].committed.node?.type, 'directory');
    assert.equal((await createWorkspaceUploadDirectories(workspace, '.', ['root/empty'])).failed.length, 0, 'existing directories are idempotent');
    await fs.writeFile(path.join(workspace.rootPath, 'conflict'), 'keep');
    const partial = await createWorkspaceUploadDirectories(workspace, '.', ['good', 'conflict']);
    assert.equal(partial.completed.length, 1);
    assert.equal(partial.failed[0].sourcePath, 'conflict');
    assert.equal(await fs.readFile(path.join(workspace.rootPath, 'conflict'), 'utf8'), 'keep');
    await assert.rejects(createWorkspaceUploadDirectories({ ...workspace, permissions: { ...workspace.permissions, canWrite: false } }, '.', ['denied']), /read-only/);
    await fs.symlink(data, path.join(workspace.rootPath, 'outside'));
    const escaped = await createWorkspaceUploadDirectories(workspace, '.', ['outside/escaped']);
    assert.equal(escaped.failed.length, 1);
    await assert.rejects(fs.stat(path.join(data, 'escaped')), { code: 'ENOENT' });
    console.log('upload-directories-test: ok');
  } finally { await fs.rm(data, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
