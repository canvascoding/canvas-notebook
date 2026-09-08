import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileWatcherService, type FileEvent } from '../app/lib/filesystem/file-watcher';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function main() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-rename-events-'));
  const workspace: WorkspaceContext = { workspaceId: 'rename-events', workspaceType: 'personal', rootPath,
    organizationId: null, ownerUserId: null, legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true, canManageWorkspace: true, canCreatePublicLinks: true } };
  const events: FileEvent[] = [];
  const secondTabEvents: FileEvent[] = [];
  const service = new FileWatcherService();
  try {
    await fs.writeFile(path.join(rootPath, 'a.txt'), 'preserved');
    service.subscribe({ id: 'test', workspaceId: workspace.workspaceId, workspace, send: (event) => events.push(event) });
    service.subscribe({ id: 'second-tab', workspaceId: workspace.workspaceId, workspace, send: (event) => secondTabEvents.push(event) });
    await service.subscribeDir('test', '.');
    const mutation = { type: 'rename' as const, operationId: 'rename-1', workspaceId: workspace.workspaceId, oldPath: 'a.txt', newPath: 'b.txt' };
    await service.withRename(workspace, mutation, async () => {
      await fs.rename(path.join(rootPath, 'a.txt'), path.join(rootPath, 'b.txt'));
      // Longer than the native debounce: the unlink must still be held.
      await new Promise((resolve) => setTimeout(resolve, 650));
      assert.deepEqual(events.filter((event) => ['a.txt', 'b.txt'].includes(event.relativePath)), []);
    });
    const renames = events.filter((event) => event.type === 'rename');
    assert.equal(renames.length, 1);
    assert.deepEqual(renames[0].mutation, mutation);
    assert.deepEqual(secondTabEvents.find((event) => event.type === 'rename')?.mutation, mutation);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(events.filter((event) => event.type === 'unlink' && event.relativePath === 'a.txt').length, 0);

    await assert.rejects(service.withRename(workspace, { ...mutation, operationId: 'rollback', oldPath: 'b.txt', newPath: 'c.txt' }, async () => {
      await fs.rename(path.join(rootPath, 'b.txt'), path.join(rootPath, 'c.txt'));
      await fs.rename(path.join(rootPath, 'c.txt'), path.join(rootPath, 'b.txt'));
      throw new Error('rolled back');
    }), /rolled back/);
    assert.equal(events.filter((event) => event.type === 'rename').length, 1, 'rollback must not publish a successful rename');
    assert.equal(await fs.readFile(path.join(rootPath, 'b.txt'), 'utf8'), 'preserved');

    await fs.mkdir(path.join(rootPath, 'folder'));
    await fs.writeFile(path.join(rootPath, 'folder', 'child.txt'), 'child');
    const folderMutation = { ...mutation, operationId: 'folder', oldPath: 'folder', newPath: 'moved-folder' };
    await service.withRename(workspace, folderMutation, () => fs.rename(path.join(rootPath, 'folder'), path.join(rootPath, 'moved-folder')));
    assert.deepEqual(secondTabEvents.find((event) => event.mutation?.operationId === 'folder')?.mutation, folderMutation);
    assert.equal(await fs.readFile(path.join(rootPath, 'moved-folder', 'child.txt'), 'utf8'), 'child');
    console.log('file-rename-events-test: ok');
  } finally {
    service.stop();
    await fs.rm(rootPath, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
