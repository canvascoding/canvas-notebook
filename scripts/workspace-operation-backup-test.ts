import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  captureWorkspaceOperationBackup,
  getWorkspaceOperationBackup,
  restoreWorkspaceOperationBackup,
  WorkspaceOperationBackupError,
} from '../app/lib/files/workspace-operation-backup';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function workspace(rootPath: string): WorkspaceContext {
  return {
    workspaceId: 'test-workspace', workspaceType: 'personal', rootPath,
    organizationId: null, ownerUserId: 'tester', legacy: false,
    permissions: {
      canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: false,
      canManageWorkspace: true, canRunAgent: true,
    },
  };
}

async function expectBackupError(run: () => Promise<unknown>, code: WorkspaceOperationBackupError['code']): Promise<void> {
  await assert.rejects(run, (error: unknown) => error instanceof WorkspaceOperationBackupError && error.code === code);
}

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-op-backup-'));
  const previousData = process.env.DATA;
  process.env.DATA = dataRoot;
  try {
  const rootPath = path.join(dataRoot, 'workspaces', 'test-workspace', 'files');
  await fs.mkdir(rootPath, { recursive: true });
  const context = workspace(rootPath);

  const markdown = `# Large Markdown\n${'x'.repeat(2 * 1024 * 1024)}\n`;
  await fs.writeFile(path.join(rootPath, 'large.md'), markdown);
  const markdownBackup = await captureWorkspaceOperationBackup({ workspace: context, path: 'large.md', operationId: 'rename_large' });
  assert.equal(markdownBackup.sizeBytes, Buffer.byteLength(markdown));
  assert.equal(markdownBackup.fileCount, 1);
  assert.equal(markdownBackup.directoryCount, 0);
  assert.equal(markdownBackup.contentSha256, sha256(JSON.stringify(markdownBackup.entries)));
  assert.equal(markdownBackup.retention, 'until_manual_cleanup');
  assert.equal((await getWorkspaceOperationBackup({ workspace: context, backupId: markdownBackup.backupId })).backupId, markdownBackup.backupId);
  await fs.unlink(path.join(rootPath, 'large.md'));
  assert.equal((await captureWorkspaceOperationBackup({ workspace: context, path: 'large.md', operationId: 'rename_large' })).backupId, markdownBackup.backupId);
  const restoredMarkdown = await restoreWorkspaceOperationBackup({ workspace: context, backupId: markdownBackup.backupId });
  assert.equal(restoredMarkdown.restoredPath, 'large.md');
  assert.equal(sha256(await fs.readFile(path.join(rootPath, 'large.md'))), sha256(markdown));
  await expectBackupError(() => restoreWorkspaceOperationBackup({ workspace: context, backupId: markdownBackup.backupId }), 'RESTORE_COLLISION');

  const binary = randomBytes(9 * 1024 * 1024);
  await fs.writeFile(path.join(rootPath, 'large.bin'), binary);
  const [binaryBackup, parallelBackup] = await Promise.all([
    captureWorkspaceOperationBackup({ workspace: context, path: 'large.bin', operationId: 'copy_large' }),
    captureWorkspaceOperationBackup({ workspace: context, path: 'large.bin', operationId: 'copy_large' }),
  ]);
  assert.equal(binaryBackup.backupId, parallelBackup.backupId);
  await fs.unlink(path.join(rootPath, 'large.bin'));
  await restoreWorkspaceOperationBackup({ workspace: context, backupId: binaryBackup.backupId, targetPath: 'restored.bin' });
  assert.equal(sha256(await fs.readFile(path.join(rootPath, 'restored.bin'))), sha256(binary));

  await fs.mkdir(path.join(rootPath, 'folder', 'empty'), { recursive: true });
  await fs.writeFile(path.join(rootPath, 'folder', 'nested.md'), markdown);
  await fs.writeFile(path.join(rootPath, 'folder', 'image.bin'), binary);
  const folderBackup = await captureWorkspaceOperationBackup({ workspace: context, path: 'folder', operationId: 'move_folder' });
  assert.equal(folderBackup.fileCount, 2);
  assert.equal(folderBackup.directoryCount, 2);
  await fs.rm(path.join(rootPath, 'folder'), { recursive: true });
  await restoreWorkspaceOperationBackup({ workspace: context, backupId: folderBackup.backupId });
  assert.equal(sha256(await fs.readFile(path.join(rootPath, 'folder', 'nested.md'))), sha256(markdown));
  assert.equal(sha256(await fs.readFile(path.join(rootPath, 'folder', 'image.bin'))), sha256(binary));
  assert((await fs.stat(path.join(rootPath, 'folder', 'empty'))).isDirectory());

  const backupFolder = path.join(dataRoot, '.workspace-operation-backups',
    sha256(JSON.stringify(['personal', null, 'test-workspace'])), binaryBackup.backupId);
  await fs.writeFile(path.join(backupFolder, 'payload'), Buffer.from('corrupt'));
  await expectBackupError(() => restoreWorkspaceOperationBackup({ workspace: context, backupId: binaryBackup.backupId, targetPath: 'corrupt-restored.bin' }), 'CORRUPT_BACKUP');
  await assert.rejects(fs.lstat(path.join(rootPath, 'corrupt-restored.bin')), { code: 'ENOENT' });

  await fs.symlink(path.join(rootPath, 'large.md'), path.join(rootPath, 'alias.md'));
  await assert.rejects(() => captureWorkspaceOperationBackup({ workspace: context, path: 'alias.md', operationId: 'alias' }));
  await fs.symlink(rootPath, path.join(rootPath, 'folder', 'nested-alias'));
  await assert.rejects(() => captureWorkspaceOperationBackup({ workspace: context, path: 'folder', operationId: 'alias_nested' }));

  console.log('workspace operation backup: large Markdown, binary, directory, idempotency, collision, corruption, symlinks OK');
  } finally {
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
