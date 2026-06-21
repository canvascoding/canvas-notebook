import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-workspace-trash-'));
  const dataRoot = path.join(tempRoot, 'data');
  const workspaceRoot = path.join(dataRoot, 'workspaces', 'team', 'org-trash', 'files');
  const previousData = process.env.DATA;
  const previousTrashRetention = process.env.WORKSPACE_TRASH_RETENTION_DAYS;
  process.env.DATA = dataRoot;
  process.env.WORKSPACE_TRASH_RETENTION_DAYS = '1';

  try {
    await fs.mkdir(path.join(workspaceRoot, 'docs', 'archive'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'docs', 'report.md'), '# Report\n');
    await fs.writeFile(path.join(workspaceRoot, 'docs', 'archive', 'old.md'), '# Old\n');

    const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
    try {
      runMigrations(sqlite);
    } finally {
      sqlite.close();
    }

    const workspace: WorkspaceContext = {
      workspaceId: 'team-ws',
      workspaceType: 'team',
      rootPath: workspaceRoot,
      rootRelativePath: 'workspaces/team/org-trash/files',
      displayName: 'Team',
      organizationId: 'org-trash',
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

    const {
      listWorkspaceTrashEntries,
      purgeExpiredWorkspaceTrash,
      restoreWorkspaceTrashEntry,
      trashWorkspacePaths,
    } = await import('../app/lib/filesystem/workspace-trash');

    const blockedRoot = await trashWorkspacePaths({
      workspace,
      paths: ['.'],
      deletedByUserId: 'user-admin',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    assert.equal(blockedRoot.trashed.length, 0);
    assert.equal(blockedRoot.failed.length, 1);
    assert.match(blockedRoot.failed[0].error, /root/i);

    const trashed = await trashWorkspacePaths({
      workspace,
      paths: ['docs/report.md', 'docs/archive', 'docs/archive/old.md'],
      deletedByUserId: 'user-admin',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    assert.equal(trashed.failed.length, 0);
    assert.equal(trashed.trashed.length, 2);
    assert.deepEqual(trashed.trashed.map((entry) => entry.originalPath).sort(), ['docs/archive', 'docs/report.md']);
    assert.equal(await exists(path.join(workspaceRoot, 'docs', 'report.md')), false);
    assert.equal(await exists(path.join(workspaceRoot, 'docs', 'archive')), false);

    for (const entry of trashed.trashed) {
      assert.equal(await exists(path.join(dataRoot, entry.trashRelativePath)), true);
      assert.equal(entry.status, 'trashed');
      assert.equal(entry.expiresAt.toISOString(), '2026-01-02T00:00:00.000Z');
    }

    const reportEntry = trashed.trashed.find((entry) => entry.originalPath === 'docs/report.md');
    assert.ok(reportEntry);
    const restored = await restoreWorkspaceTrashEntry({
      workspace,
      entryId: reportEntry.id,
      restoredByUserId: 'user-admin',
      now: new Date('2026-01-01T01:00:00.000Z'),
    });
    assert.equal(restored.status, 'restored');
    assert.equal(await exists(path.join(workspaceRoot, 'docs', 'report.md')), true);
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'docs', 'report.md'), 'utf8'), '# Report\n');

    const purge = await purgeExpiredWorkspaceTrash({
      now: new Date('2026-01-03T00:00:00.000Z'),
      purgedByUserId: 'system-cleanup',
    });
    assert.equal(purge.failed.length, 0);
    assert.equal(purge.purged.length, 1);

    const activeTrash = await listWorkspaceTrashEntries({ workspace });
    assert.equal(activeTrash.length, 0);

    const verifyDb = new Database(path.join(dataRoot, 'sqlite.db'), { readonly: true, fileMustExist: true });
    try {
      const rows = verifyDb.prepare('SELECT original_path AS originalPath, status FROM workspace_trash_entries ORDER BY original_path').all() as Array<{
        originalPath: string;
        status: string;
      }>;
      assert.deepEqual(rows, [
        { originalPath: 'docs/archive', status: 'purged' },
        { originalPath: 'docs/report.md', status: 'restored' },
      ]);
    } finally {
      verifyDb.close();
    }

    console.log('workspace-trash-retention-test: ok');
  } finally {
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    if (previousTrashRetention === undefined) delete process.env.WORKSPACE_TRASH_RETENTION_DAYS;
    else process.env.WORKSPACE_TRASH_RETENTION_DAYS = previousTrashRetention;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
