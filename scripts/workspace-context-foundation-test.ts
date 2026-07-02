import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-workspace-foundation-'));
  const dataRoot = path.join(tempRoot, 'data');
  const outsideRoot = path.join(tempRoot, 'outside');
  process.env.DATA = dataRoot;

  const [
    contextModule,
    pathGuardModule,
    permissionsModule,
    workspaceFilesModule,
    fileReferenceCacheModule,
    fileTreeCacheModule,
  ] = await Promise.all([
    import('../app/lib/workspaces/context'),
    import('../app/lib/workspaces/path-guard'),
    import('../app/lib/workspaces/permissions'),
    import('../app/lib/filesystem/workspace-files'),
    import('../app/lib/filesystem/file-reference-cache'),
    import('../app/lib/utils/file-tree-cache'),
  ]);

  const previousData = process.env.DATA;
  process.env.DATA = 'custom-data';
  assert.equal(
    contextModule.resolveWorkspaceDataRoot(path.join(tempRoot, 'runtime')),
    path.join(tempRoot, 'runtime', 'custom-data')
  );
  process.env.DATA = previousData;

  const workspace = contextModule.createLegacyPersonalWorkspaceContext({
    userId: 'user-1',
    email: 'user@example.com',
    role: 'member',
  });

  assert.equal(workspace.workspaceType, 'personal');
  assert.equal(workspace.legacy, true);
  assert.equal(workspace.rootPath, path.join(dataRoot, 'workspace'));
  assert.equal(workspace.permissions.canRead, true);
  assert.equal(workspace.permissions.canWrite, true);
  assert.equal(workspace.permissions.canDelete, true);
  assert.equal(workspace.permissions.canCreatePublicLinks, true);

  await fs.mkdir(workspace.rootPath, { recursive: true });
  await fs.mkdir(outsideRoot, { recursive: true });
  await fs.writeFile(path.join(workspace.rootPath, 'notes.md'), '# Notes');
  await fs.writeFile(path.join(outsideRoot, 'secret.txt'), 'secret');

  assert.equal(
    workspaceFilesModule.validatePath('notes.md'),
    path.join(workspace.rootPath, 'notes.md')
  );
  assert.equal(
    await workspaceFilesModule.readFile('notes.md').then((buffer) => buffer.toString('utf8')),
    '# Notes'
  );

  assert.throws(
    () => workspaceFilesModule.validatePath('../outside/secret.txt'),
    /directory traversal/i
  );
  assert.throws(
    () => workspaceFilesModule.validatePath('nested/../notes.md'),
    /directory traversal/i
  );
  assert.throws(
    () => workspaceFilesModule.validatePath('/etc/passwd'),
    /directory traversal/i
  );
  assert.throws(
    () => workspaceFilesModule.validatePath('C:/Windows/System32/drivers/etc/hosts'),
    /directory traversal/i
  );
  assert.throws(
    () => workspaceFilesModule.validatePath('C:/'),
    /directory traversal/i
  );
  assert.throws(
    () => workspaceFilesModule.validatePath('bad\0path'),
    /directory traversal/i
  );

  const symlinkPath = path.join(workspace.rootPath, 'outside-link');
  await fs.symlink(outsideRoot, symlinkPath);
  await assert.rejects(
    () => workspaceFilesModule.resolveExistingWorkspacePath('outside-link/secret.txt'),
    /directory traversal/i
  );
  await assert.rejects(
    () => workspaceFilesModule.writeFile('outside-link/new.txt', 'blocked'),
    /directory traversal/i
  );

  await workspaceFilesModule.createDirectory('nested/folder');
  await workspaceFilesModule.writeFile('nested/folder/file.txt', 'ok');
  assert.equal(
    await workspaceFilesModule.readFile('nested/folder/file.txt').then((buffer) => buffer.toString('utf8')),
    'ok'
  );

  const teamMemberPermissions = permissionsModule.resolveWorkspacePermissions({
    role: 'member',
    workspaceType: 'team',
    canAccessTeamWorkspace: true,
    canWriteTeamWorkspace: true,
  });
  assert.equal(teamMemberPermissions.canRead, true);
  assert.equal(teamMemberPermissions.canWrite, true);
  assert.equal(teamMemberPermissions.canDelete, true);
  assert.equal(teamMemberPermissions.canCreatePublicLinks, true);
  assert.equal(teamMemberPermissions.canManageWorkspace, false);

  const externalPermissions = permissionsModule.resolveWorkspacePermissions({
    role: 'external',
    workspaceType: 'team',
    canAccessTeamWorkspace: true,
    canWriteTeamWorkspace: true,
  });
  assert.equal(externalPermissions.canRead, false);
  assert.equal(externalPermissions.canWrite, false);
  assert.equal(externalPermissions.canCreatePublicLinks, false);

  await assert.rejects(
    () => pathGuardModule.resolveExistingWorkspacePath(workspace, 'missing.txt'),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
  );

  const workspaceA = {
    ...workspace,
    workspaceId: 'workspace-a',
    rootPath: path.join(tempRoot, 'workspace-a'),
  };
  const workspaceB = {
    ...workspace,
    workspaceId: 'workspace-b',
    rootPath: path.join(tempRoot, 'workspace-b'),
  };
  await workspaceFilesModule.writeFile('a.md', 'A', { workspace: workspaceA });
  await workspaceFilesModule.writeFile('b.md', 'B', { workspace: workspaceB });

  const treeKey = fileTreeCacheModule.buildFileTreeCacheKey('docs', 4, 'workspace-a');
  const parsedTreeKey = fileTreeCacheModule.parseFileTreeCacheKey(treeKey);
  assert.equal(parsedTreeKey.workspaceId, 'workspace-a');
  assert.equal(parsedTreeKey.path, 'docs');
  assert.equal(parsedTreeKey.depth, 4);
  assert.equal(parsedTreeKey.includeStats, true);

  const fastTreeKey = fileTreeCacheModule.buildFileTreeCacheKey('docs', 0, 'workspace-a', false);
  const parsedFastTreeKey = fileTreeCacheModule.parseFileTreeCacheKey(fastTreeKey);
  assert.equal(parsedFastTreeKey.workspaceId, 'workspace-a');
  assert.equal(parsedFastTreeKey.path, 'docs');
  assert.equal(parsedFastTreeKey.depth, 0);
  assert.equal(parsedFastTreeKey.includeStats, false);

  fileReferenceCacheModule.invalidateFileReferenceCache();
  const workspaceAFiles = await fileReferenceCacheModule.getCachedFileReferenceEntries(false, { workspace: workspaceA });
  const workspaceBFiles = await fileReferenceCacheModule.getCachedFileReferenceEntries(false, { workspace: workspaceB });
  assert.deepEqual(workspaceAFiles.map((entry) => entry.path), ['a.md']);
  assert.deepEqual(workspaceBFiles.map((entry) => entry.path), ['b.md']);

  await workspaceFilesModule.writeFile('a-2.md', 'A2', { workspace: workspaceA });
  await workspaceFilesModule.writeFile('b-2.md', 'B2', { workspace: workspaceB });
  fileReferenceCacheModule.invalidateFileReferenceCache({ workspace: workspaceA });
  const refreshedWorkspaceAFiles = await fileReferenceCacheModule.getCachedFileReferenceEntries(false, { workspace: workspaceA });
  const cachedWorkspaceBFiles = await fileReferenceCacheModule.getCachedFileReferenceEntries(false, { workspace: workspaceB });
  assert.deepEqual(refreshedWorkspaceAFiles.map((entry) => entry.path).sort(), ['a-2.md', 'a.md']);
  assert.deepEqual(cachedWorkspaceBFiles.map((entry) => entry.path), ['b.md']);

  await fs.rm(tempRoot, { recursive: true, force: true });
  console.log('workspace-context-foundation-test: ok');
}

void main();
