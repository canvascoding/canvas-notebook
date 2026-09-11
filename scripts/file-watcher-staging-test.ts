import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileWatcherService, type FileEvent } from '../app/lib/filesystem/file-watcher';
import { buildFileTree, listDirectory, writeFile, writeFileIfAbsent } from '../app/lib/filesystem/workspace-files';
import { isInternalWorkspaceStagingPath } from '../app/lib/files/internal-staging-path';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-staging-watcher-'));
  const originalData = process.env.DATA;
  process.env.DATA = root;
  const workspace: WorkspaceContext = {
    workspaceId: 'staging-watcher', workspaceType: 'personal', rootPath: path.join(root, 'workspace'),
    organizationId: null, ownerUserId: null, legacy: false,
    permissions: { canRead: true, canWrite: true, canDelete: true, canRunAgent: true,
      canManageWorkspace: true, canCreatePublicLinks: true },
  };
  const service = new FileWatcherService();
  const events: FileEvent[] = [];
  const assertHiddenWhileStaged = async () => {
    assert.equal((await fs.readdir(workspace.rootPath)).filter(isInternalWorkspaceStagingPath).length, 1);
    for (const includeMetadata of [true, false]) {
      const listing = await listDirectory('.', { workspace, includeMetadata });
      assert.equal(listing.filter((entry) => isInternalWorkspaceStagingPath(entry.path)).length, 0,
        'a manual directory refresh cannot expose the live writer staging file');
    }
    const tree = await buildFileTree('.', 0, 0, { workspace });
    assert.equal(tree.filter((entry) => isInternalWorkspaceStagingPath(entry.path)).length, 0);
    // Keep the real writer's temporary file alive beyond native debounce.
    await delay(300);
  };
  try {
    await fs.mkdir(workspace.rootPath);
    service.subscribe({ id: 'staging-client', workspaceId: workspace.workspaceId, workspace, send: (event) => events.push(event) });
    await service.subscribeDir('staging-client', '.');
    for (let edit = 0; edit < 4; edit++) {
      await writeFile('live.md', `Edit ${edit}`, { workspace }, assertHiddenWhileStaged);
      await delay(300);
    }
    await writeFileIfAbsent('created.md', 'Created atomically', { workspace }, assertHiddenWhileStaged);
    await delay(300);
    assert.equal(events.filter((event) => isInternalWorkspaceStagingPath(event.relativePath)).length, 0,
      'the actual atomic writer must never expose staging add/change/unlink to subscribed clients');
    assert.ok(events.filter((event) => event.relativePath === 'live.md').length >= 1,
      'committed document changes must still be delivered');

    const ordinary = ['user.tmp', 'notes.canvas-write-draft.tmp', 'notes.canvas-create-not-a-uuid.tmp'];
    for (const name of ordinary) await fs.writeFile(path.join(workspace.rootPath, name), 'user-owned');
    await delay(400);
    for (const name of ordinary) assert.ok(events.some((event) => event.relativePath === name && event.type === 'add'));
    for (const includeMetadata of [true, false]) {
      const visibleNames = (await listDirectory('.', { workspace, includeMetadata })).map((entry) => entry.name);
      for (const name of [...ordinary, 'live.md', 'created.md']) assert.ok(visibleNames.includes(name),
        'normal .tmp files and committed documents must remain visible');
    }
    await fs.unlink(path.join(workspace.rootPath, 'live.md'));
    await fs.unlink(path.join(workspace.rootPath, 'user.tmp'));
    await delay(400);
    for (const name of ['live.md', 'user.tmp']) assert.ok(events.some((event) => event.relativePath === name && event.type === 'unlink'),
      'real document and user .tmp deletions must remain visible');
  } finally {
    service.stop();
    if (originalData === undefined) delete process.env.DATA;
    else process.env.DATA = originalData;
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('file-watcher-staging-test: ok');
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
