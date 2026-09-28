import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { captureWorkspaceOperationBackup, listWorkspaceOperationBackups,
  WorkspaceOperationBackupError } from '../app/lib/files/workspace-operation-backup';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

function workspace(rootPath: string, workspaceId: string): WorkspaceContext {
  return {
    workspaceId, workspaceType: 'personal', rootPath,
    organizationId: null, ownerUserId: 'tester', legacy: false,
    permissions: {
      canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
      canManageWorkspace: true, canRunAgent: true,
    },
  };
}

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-op-backup-list-'));
  const previousData = process.env.DATA;
  process.env.DATA = dataRoot;
  try {
    const rootA = path.join(dataRoot, 'workspaces', 'a', 'files');
    const rootB = path.join(dataRoot, 'workspaces', 'b', 'files');
    await Promise.all([fs.mkdir(rootA, { recursive: true }), fs.mkdir(rootB, { recursive: true })]);
    const a = workspace(rootA, 'a');
    const b = workspace(rootB, 'b');
    await fs.writeFile(path.join(rootA, 'one.md'), 'one');
    await fs.writeFile(path.join(rootA, 'two.md'), 'two');
    await fs.writeFile(path.join(rootB, 'other.md'), 'other');
    const first = await captureWorkspaceOperationBackup({ workspace: a, path: 'one.md', operationId: 'first' });
    const second = await captureWorkspaceOperationBackup({ workspace: a, path: 'two.md', operationId: 'second' });
    const other = await captureWorkspaceOperationBackup({ workspace: b, path: 'other.md', operationId: 'other' });

    const firstPage = await listWorkspaceOperationBackups({ workspace: a, limit: 1 });
    assert.equal(firstPage.backups.length, 1);
    assert(firstPage.nextCursor);
    const secondPage = await listWorkspaceOperationBackups({
      workspace: a, limit: 1, cursor: firstPage.nextCursor,
    });
    assert.equal(secondPage.backups.length, 1);
    assert.equal(secondPage.nextCursor, null);
    const entries = [...firstPage.backups, ...secondPage.backups];
    assert.deepEqual(entries.map((entry) => entry.backupId).sort(), [first.backupId, second.backupId].sort());
    assert(entries.every((entry) => entry.status === 'manifest_valid'));
    assert(entries.every((entry) => entry.status !== 'manifest_valid' || entry.retention === 'until_manual_cleanup'));
    const otherList = await listWorkspaceOperationBackups({ workspace: b });
    assert.deepEqual(otherList.backups.map((entry) => entry.backupId), [other.backupId]);
    assert(!entries.some((entry) => entry.backupId === other.backupId));

    const backupScope = path.join(dataRoot, '.workspace-operation-backups');
    const aScope = (await fs.readdir(backupScope, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
    const aBackupFolder = (await Promise.all(aScope.map(async (entry) => {
      const folder = path.join(backupScope, entry.name, first.backupId);
      return await fs.access(folder).then(() => folder, () => null);
    }))).find((folder): folder is string => folder !== null);
    assert(aBackupFolder);
    await fs.writeFile(path.join(aBackupFolder, 'manifest.json'), '{}');
    const afterCorruption = await listWorkspaceOperationBackups({ workspace: a });
    assert(afterCorruption.backups.some((entry) => entry.backupId === first.backupId
      && entry.status === 'unavailable'));
    await assert.rejects(() => listWorkspaceOperationBackups({ workspace: a, limit: 101 }),
      (error: unknown) => error instanceof WorkspaceOperationBackupError && error.code === 'INVALID_BACKUP');
    await assert.rejects(() => listWorkspaceOperationBackups({ workspace: a, cursor: '../other' }),
      (error: unknown) => error instanceof WorkspaceOperationBackupError && error.code === 'INVALID_BACKUP');
    console.log('workspace operation backup list: pagination, workspace isolation, corruption, validation OK');
  } finally {
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
