import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

import { restoreWorkspaceOperationBackup } from '../app/lib/files/workspace-operation-backup';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function main(): Promise<void> {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-overwrite-backup-'));
  const previousData = process.env.DATA;
  process.env.DATA = dataRoot;
  const internals = Module as typeof Module & { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
  const originalLoad = internals._load;
  let guardDepth = 0;
  internals._load = (request, parent, isMain) => {
    if (request === '@/app/lib/files/workspace-file-lifecycle-guard') return {
      withWorkspaceFileLifecycleGuards: async (_scopes: unknown, work: () => Promise<unknown>) => {
        guardDepth += 1;
        try { return await work(); } finally { guardDepth -= 1; }
      },
    };
    if (request === '@/app/lib/files/collaboration-policy' || request === path.resolve('app/lib/files/collaboration-policy.ts')) return {
      // This fixture contains binary files only; live/Office ownership is tested separately against PostgreSQL.
      detectFileCollaborationStrategy: () => 'none',
      initializeCopiedFileCollaborationPaths: async () => { assert.equal(guardDepth, 1); },
    };
    return originalLoad(request, parent, isMain);
  };
  try {
    const { batchCopyBetweenWorkspaces } = await import('../app/lib/filesystem/workspace-files');
    const rootPath = path.join(dataRoot, 'workspaces', 'overwrite-test', 'files');
    await fs.mkdir(path.join(rootPath, 'source'), { recursive: true });
    await fs.mkdir(path.join(rootPath, 'destination'), { recursive: true });
    const workspace: WorkspaceContext = {
      workspaceId: 'overwrite-test', workspaceType: 'personal', rootPath,
      organizationId: null, ownerUserId: 'test-user', legacy: false,
      permissions: { canRead: true, canWrite: true, canDelete: true,
        canCreatePublicLinks: false, canManageWorkspace: true, canRunAgent: true },
    };
    const previous = randomBytes(9 * 1024 * 1024);
    const replacement = randomBytes(2 * 1024 * 1024);
    await fs.writeFile(path.join(rootPath, 'source', 'large.bin'), replacement);
    await fs.writeFile(path.join(rootPath, 'destination', 'large.bin'), previous);

    const copied = await batchCopyBetweenWorkspaces(['source/large.bin'], 'destination', true, false,
      { source: { workspace }, target: { workspace } });
    assert.deepEqual(copied.failed, []);
    assert.equal(copied.backups?.length, 1);
    assert.equal(sha256(await fs.readFile(path.join(rootPath, 'destination', 'large.bin'))), sha256(replacement));
    await restoreWorkspaceOperationBackup({ workspace, backupId: copied.backups![0].backupId,
      targetPath: 'recovered.bin' });
    assert.equal(sha256(await fs.readFile(path.join(rootPath, 'recovered.bin'))), sha256(previous));

    await fs.writeFile(path.join(rootPath, 'destination', 'large.bin'), previous);
    const originalCp = fs.cp;
    fs.cp = async () => { throw new Error('Simulated copy failure after durable backup'); };
    let failed;
    try {
      failed = await batchCopyBetweenWorkspaces(['source/large.bin'], 'destination', true, false,
        { source: { workspace }, target: { workspace } });
    } finally { fs.cp = originalCp; }
    assert.equal(failed.failed.length, 1);
    assert.match(failed.failed[0].error, /Simulated copy failure/u);
    assert.equal(failed.backups?.length, 1);
    assert.equal(failed.failed[0].backupId, failed.backups![0].backupId);
    await restoreWorkspaceOperationBackup({ workspace, backupId: failed.backups![0].backupId,
      targetPath: 'recovered-after-failure.bin' });
    assert.equal(sha256(await fs.readFile(path.join(rootPath, 'recovered-after-failure.bin'))), sha256(previous));
    console.log('workspace overwrite backup: large binary and recovery after copy failure OK');
  } finally {
    internals._load = originalLoad;
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
