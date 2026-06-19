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
  ] = await Promise.all([
    import('../app/lib/workspaces/context'),
    import('../app/lib/workspaces/path-guard'),
    import('../app/lib/workspaces/permissions'),
    import('../app/lib/filesystem/workspace-files'),
  ]);

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
    () => workspaceFilesModule.validatePath('/etc/passwd'),
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

  await fs.rm(tempRoot, { recursive: true, force: true });
  console.log('workspace-context-foundation-test: ok');
}

void main();
