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
    pathUtilsModule,
  ] = await Promise.all([
    import('../app/lib/workspaces/context'),
    import('../app/lib/workspaces/path-guard'),
    import('../app/lib/workspaces/permissions'),
    import('../app/lib/filesystem/workspace-files'),
    import('../app/lib/filesystem/file-reference-cache'),
    import('../app/lib/utils/file-tree-cache'),
    import('../app/lib/files/path-utils'),
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
  assert.equal(workspace.permissions.canManageWorkspace, true);

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

  for (const filePath of ['name.md', ' name.md', 'name.markdown', ' name.markdown', ' Dir / Note .md']) {
    assert.equal(pathGuardModule.normalizeWorkspaceRelativePath(filePath), filePath);
    assert.equal(pathUtilsModule.normalizeWorkspacePathParam(filePath), filePath);
    const resolved = pathGuardModule.resolveWorkspacePath(workspace, filePath);
    assert.equal(resolved.relativePath, filePath);
    assert.equal(resolved.absolutePath, path.join(workspace.rootPath, filePath));
    assert.equal(workspaceFilesModule.validatePath(filePath), resolved.absolutePath);
    const content = Buffer.from(`Exact Markdown identity: ${filePath}\n`);
    await workspaceFilesModule.createWorkspaceFileParentDirectory(filePath);
    await workspaceFilesModule.writeFile(filePath, content);
    assert.deepEqual(await workspaceFilesModule.readFile(filePath), content);
    assert.deepEqual(await fs.readFile(resolved.absolutePath), content);
  }
  assert.notEqual((await fs.stat(path.join(workspace.rootPath, 'name.md'))).ino,
    (await fs.stat(path.join(workspace.rootPath, ' name.md'))).ino);
  assert.notEqual((await fs.stat(path.join(workspace.rootPath, 'name.markdown'))).ino,
    (await fs.stat(path.join(workspace.rootPath, ' name.markdown'))).ino);
  await assert.rejects(fs.stat(path.join(workspace.rootPath, 'Dir')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(workspace.rootPath, ' Dir /Note .md')), { code: 'ENOENT' });
  for (const value of [' alias.docx ', ' alias.txt ']) {
    assert.equal(pathGuardModule.normalizeWorkspaceRelativePath(value), value.trim());
    assert.equal(pathUtilsModule.normalizeWorkspacePathParam(value), value.trim());
  }
  const parentBefore = (await fs.readdir(dataRoot)).sort();
  const rootBefore = (await fs.readdir(workspace.rootPath)).sort();
  for (const value of ['.', '  ', '../forbidden-parent/file.md', 'nested/../../forbidden-parent/file.md']) {
    await assert.rejects(workspaceFilesModule.createWorkspaceFileParentDirectory(value));
  }
  assert.deepEqual((await fs.readdir(dataRoot)).sort(), parentBefore);
  assert.deepEqual((await fs.readdir(workspace.rootPath)).sort(), rootBefore);
  await assert.rejects(fs.stat(path.join(dataRoot, 'forbidden-parent')), { code: 'ENOENT' });
  for (const value of ['../outside.md', 'nested/../outside.md', 'bad\0path.md']) {
    assert.equal(pathUtilsModule.normalizeWorkspacePathParam(value), null);
  }

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
  await assert.rejects(
    () => workspaceFilesModule.createWorkspaceFileParentDirectory('outside-link/new-parent/file.md'),
    /directory traversal/i
  );
  await assert.rejects(fs.stat(path.join(outsideRoot, 'new-parent')), { code: 'ENOENT' });

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
    canDeleteTeamWorkspace: false,
  });
  assert.equal(teamMemberPermissions.canRead, true);
  assert.equal(teamMemberPermissions.canWrite, true);
  assert.equal(teamMemberPermissions.canDelete, false);
  assert.equal(teamMemberPermissions.canCreatePublicLinks, true);
  assert.equal(teamMemberPermissions.canManageWorkspace, false);

  const teamDeleteOnlyPermissions = permissionsModule.resolveWorkspacePermissions({
    role: 'member',
    workspaceType: 'team',
    canAccessTeamWorkspace: true,
    canWriteTeamWorkspace: false,
    canDeleteTeamWorkspace: true,
  });
  assert.equal(teamDeleteOnlyPermissions.canRead, true);
  assert.equal(teamDeleteOnlyPermissions.canWrite, false);
  assert.equal(teamDeleteOnlyPermissions.canDelete, true);

  const personalOwnerPermissions = permissionsModule.resolveWorkspacePermissions({
    role: 'member',
    workspaceType: 'personal',
    ownsPersonalWorkspace: true,
    canCreatePublicLinks: true,
  });
  assert.equal(personalOwnerPermissions.canRead, true);
  assert.equal(personalOwnerPermissions.canWrite, true);
  assert.equal(personalOwnerPermissions.canDelete, true);
  assert.equal(personalOwnerPermissions.canCreatePublicLinks, true);
  assert.equal(personalOwnerPermissions.canManageWorkspace, true);
  assert.equal(personalOwnerPermissions.canRunAgent, true);

  const organizationDeletePermissions = permissionsModule.resolveWorkspacePermissions({
    role: 'member',
    workspaceType: 'organization',
    canAccessOrganizationWorkspace: true,
    canWriteOrganizationWorkspace: false,
    canDeleteOrganizationWorkspace: true,
  });
  assert.equal(organizationDeletePermissions.canRead, true);
  assert.equal(organizationDeletePermissions.canWrite, false);
  assert.equal(organizationDeletePermissions.canDelete, true);

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
