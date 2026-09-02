import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renameWorkspacePath, type WorkspacePathRenameOperations } from '../app/lib/files/rename-service';
import { withRollbackableFileRename } from '../app/lib/filesystem/workspace-files';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const workspace: WorkspaceContext = {
  workspaceId: 'rename-test-workspace',
  workspaceType: 'organization',
  rootPath: '/tmp/rename-test-workspace',
  organizationId: 'rename-test-organization',
  ownerUserId: null,
  permissions: {
    canRead: true,
    canWrite: true,
    canDelete: true,
    canCreatePublicLinks: true,
    canManageWorkspace: true,
    canRunAgent: true,
  },
  legacy: false,
};

const params = {
  workspace,
  oldPath: 'source.txt',
  newPath: 'destination.txt',
  overwrite: false,
  fileOptions: { workspace },
};

function fakeOperations(
  events: string[],
  overrides: Partial<WorkspacePathRenameOperations> = {},
): WorkspacePathRenameOperations {
  return {
    withFileRename: async (input, operation) => {
      events.push(`file:${input.oldPath}->${input.newPath}`);
      try {
        return await operation();
      } catch (error) {
        events.push(`file:${input.newPath}->${input.oldPath}`);
        throw error;
      }
    },
    moveCollaborationPath: async (input) => {
      events.push(`collaboration:${input.oldPath}->${input.newPath}`);
    },
    archiveCollaborationPath: async (input) => {
      events.push(`archive:${input.path}`);
    },
    moveMetadataPath: async (input) => {
      events.push(`metadata:${input.oldPath}->${input.newPath}`);
    },
    deleteMetadataPath: async (input) => {
      events.push(`delete-metadata:${input.path}`);
    },
    syncPublicShares: async (input) => {
      events.push(`shares:${input.oldPath}->${input.newPath}:${input.overwrite}`);
    },
    queuePublicShareSync: (input) => {
      events.push(`queue-shares:${input.oldPath}->${input.newPath}:${input.overwrite}`);
    },
    createBackupPath: () => '.canvas-rename-backups/test-backup',
    ...overrides,
  };
}

async function testProjectionRollback(): Promise<void> {
  const events: string[] = [];
  const operations = fakeOperations(events, {
    moveMetadataPath: async (input) => {
      events.push(`metadata:${input.oldPath}->${input.newPath}`);
      if (input.oldPath === params.oldPath) throw new Error('metadata move failed');
    },
  });
  await assert.rejects(renameWorkspacePath(params, operations), /metadata move failed/u);
  assert.deepEqual(events, [
    'file:source.txt->destination.txt',
    'collaboration:source.txt->destination.txt',
    'metadata:source.txt->destination.txt',
    'collaboration:destination.txt->source.txt',
    'file:destination.txt->source.txt',
  ]);
}

async function testOverwriteProjectionRollback(): Promise<void> {
  const events: string[] = [];
  const backupPath = '.canvas-rename-backups/test-backup';
  const operations = fakeOperations(events, {
    moveMetadataPath: async (input) => {
      events.push(`metadata:${input.oldPath}->${input.newPath}`);
      if (input.oldPath === params.oldPath) throw new Error('source metadata move failed');
    },
  });
  await assert.rejects(renameWorkspacePath({ ...params, overwrite: true }, operations), /source metadata move failed/u);
  assert.deepEqual(events, [
    `collaboration:destination.txt->${backupPath}`,
    `metadata:destination.txt->${backupPath}`,
    'file:source.txt->destination.txt',
    'collaboration:source.txt->destination.txt',
    'metadata:source.txt->destination.txt',
    'collaboration:destination.txt->source.txt',
    'file:destination.txt->source.txt',
    `metadata:${backupPath}->destination.txt`,
    `collaboration:${backupPath}->destination.txt`,
  ]);
}

async function testShareRetryWarning(): Promise<void> {
  const events: string[] = [];
  const operations = fakeOperations(events, {
    syncPublicShares: async () => {
      events.push('shares:failed');
      throw new Error('share database unavailable');
    },
  });
  const result = await renameWorkspacePath(params, operations);
  assert.deepEqual(result.warnings, ['Public share sync: share database unavailable']);
  assert.equal(events.at(-1), 'queue-shares:source.txt->destination.txt:false');
}

async function testFilesystemRollback(): Promise<void> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-file-rename-test-'));
  const fileWorkspace = { ...workspace, rootPath };
  const options = { workspace: fileWorkspace };
  try {
    await fs.writeFile(path.join(rootPath, 'source.txt'), 'source');
    await fs.writeFile(path.join(rootPath, 'destination.txt'), 'destination');
    await assert.rejects(
      withRollbackableFileRename('source.txt', 'destination.txt', true, options, async () => {
        throw new Error('projection failed');
      }),
      /projection failed/u,
    );
    assert.equal(await fs.readFile(path.join(rootPath, 'source.txt'), 'utf8'), 'source');
    assert.equal(await fs.readFile(path.join(rootPath, 'destination.txt'), 'utf8'), 'destination');

    await fs.mkdir(path.join(rootPath, 'folder'));
    await fs.writeFile(path.join(rootPath, 'folder', 'nested.txt'), 'nested');
    await assert.rejects(
      withRollbackableFileRename('folder', 'renamed-folder', false, options, async () => {
        throw new Error('folder projection failed');
      }),
      /folder projection failed/u,
    );
    assert.equal(await fs.readFile(path.join(rootPath, 'folder', 'nested.txt'), 'utf8'), 'nested');
    await assert.rejects(fs.access(path.join(rootPath, 'renamed-folder')));
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  await testProjectionRollback();
  await testOverwriteProjectionRollback();
  await testShareRetryWarning();
  await testFilesystemRollback();
  console.log('file-rename-service-test: ok');
}

void main();
