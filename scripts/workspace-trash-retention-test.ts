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

function execSqlite(dataRoot: string, sql: string) {
  const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
  try {
    sqlite.exec(sql);
  } finally {
    sqlite.close();
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
      sqlite.exec(`
        INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
        VALUES ('user-admin', 'Admin', 'admin@example.test', 1, 1767225600000, 1767225600000);

        INSERT INTO canvas_organization_settings (
          organization_id,
          owner_user_id,
          deployment_mode,
          team_features_enabled,
          created_at,
          updated_at
        )
        VALUES ('org-trash', 'user-admin', 'team', 1, 1767225600000, 1767225600000);

        INSERT INTO canvas_workspaces (
          id,
          organization_id,
          type,
          root_relative_path,
          display_name,
          status,
          created_at,
          updated_at
        )
        VALUES (
          'team-ws',
          'org-trash',
          'team',
          'workspaces/team/org-trash/files',
          'Team',
          'active',
          1767225600000,
          1767225600000
        );
      `);
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

    await fs.writeFile(path.join(workspaceRoot, 'docs', 'mixed-valid.md'), '# Mixed\n');
    const mixedBatch = await trashWorkspacePaths({
      workspace,
      paths: ['docs/mixed-valid.md', '../outside'],
      deletedByUserId: 'user-admin',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    assert.equal(mixedBatch.trashed.length, 1);
    assert.equal(mixedBatch.failed.length, 1);
    assert.equal(mixedBatch.trashed[0].originalPath, 'docs/mixed-valid.md');
    assert.match(mixedBatch.failed[0].error, /traversal|outside|invalid/i);
    assert.equal(await exists(path.join(workspaceRoot, 'docs', 'mixed-valid.md')), false);

    await fs.writeFile(path.join(workspaceRoot, 'docs', 'insert-rollback.md'), '# Insert rollback\n');
    execSqlite(dataRoot, `
      CREATE TRIGGER fail_workspace_trash_insert
      BEFORE INSERT ON workspace_trash_entries
      BEGIN
        SELECT RAISE(FAIL, 'trash insert failed');
      END;
    `);
    try {
      const insertRollback = await trashWorkspacePaths({
        workspace,
        paths: ['docs/insert-rollback.md'],
        deletedByUserId: 'user-admin',
        now: new Date('2026-01-01T00:00:00.000Z'),
      });
      assert.equal(insertRollback.trashed.length, 0);
      assert.equal(insertRollback.failed.length, 1);
      assert.match(insertRollback.failed[0].error, /trash insert failed/);
      assert.equal(await exists(path.join(workspaceRoot, 'docs', 'insert-rollback.md')), true);
      assert.equal(
        await fs.readFile(path.join(workspaceRoot, 'docs', 'insert-rollback.md'), 'utf8'),
        '# Insert rollback\n'
      );
    } finally {
      execSqlite(dataRoot, 'DROP TRIGGER IF EXISTS fail_workspace_trash_insert;');
    }

    await fs.mkdir(path.join(workspaceRoot, 'docs', 'links'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, 'docs', 'links', 'note.md'), '# Link note\n');
    await fs.symlink(
      path.join(workspaceRoot, 'docs', 'links'),
      path.join(workspaceRoot, 'docs', 'links', 'self'),
      'dir'
    );
    const symlinkBatch = await trashWorkspacePaths({
      workspace,
      paths: ['docs/links'],
      deletedByUserId: 'user-admin',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    assert.equal(symlinkBatch.failed.length, 0);
    assert.equal(symlinkBatch.trashed.length, 1);
    assert.equal(symlinkBatch.trashed[0].originalPath, 'docs/links');
    assert.equal(symlinkBatch.trashed[0].fileCount, 1);
    assert.equal(symlinkBatch.trashed[0].directoryCount, 1);
    assert.equal(await exists(path.join(workspaceRoot, 'docs', 'links')), false);

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
    execSqlite(dataRoot, `
      CREATE TRIGGER fail_workspace_trash_restore_update
      BEFORE UPDATE OF status ON workspace_trash_entries
      WHEN NEW.status = 'restored'
      BEGIN
        SELECT RAISE(FAIL, 'restore update failed');
      END;
    `);
    try {
      await assert.rejects(
        () => restoreWorkspaceTrashEntry({
          workspace,
          entryId: reportEntry.id,
          restoredByUserId: 'user-admin',
          now: new Date('2026-01-01T00:30:00.000Z'),
        }),
        /restore update failed/
      );
      assert.equal(await exists(path.join(workspaceRoot, 'docs', 'report.md')), false);
      assert.equal(await exists(path.join(dataRoot, reportEntry.trashRelativePath)), true);
    } finally {
      execSqlite(dataRoot, 'DROP TRIGGER IF EXISTS fail_workspace_trash_restore_update;');
    }

    const restored = await restoreWorkspaceTrashEntry({
      workspace,
      entryId: reportEntry.id,
      restoredByUserId: 'user-admin',
      now: new Date('2026-01-01T01:00:00.000Z'),
    });
    assert.equal(restored.status, 'restored');
    assert.equal(await exists(path.join(workspaceRoot, 'docs', 'report.md')), true);
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'docs', 'report.md'), 'utf8'), '# Report\n');

    await fs.writeFile(path.join(workspaceRoot, 'docs', 'overwrite.md'), '# Replacement\n');
    const overwriteTrash = await trashWorkspacePaths({
      workspace,
      paths: ['docs/overwrite.md'],
      deletedByUserId: 'user-admin',
      now: new Date('2026-01-01T01:05:00.000Z'),
    });
    assert.equal(overwriteTrash.failed.length, 0);
    assert.equal(overwriteTrash.trashed.length, 1);
    const overwriteEntry = overwriteTrash.trashed[0];
    await fs.writeFile(path.join(workspaceRoot, 'docs', 'overwrite.md'), '# Existing destination\n');
    execSqlite(dataRoot, `
      CREATE TRIGGER fail_workspace_trash_overwrite_restore_update
      BEFORE UPDATE OF status ON workspace_trash_entries
      WHEN NEW.status = 'restored'
      BEGIN
        SELECT RAISE(FAIL, 'overwrite restore update failed');
      END;
    `);
    try {
      await assert.rejects(
        () => restoreWorkspaceTrashEntry({
          workspace,
          entryId: overwriteEntry.id,
          restoredByUserId: 'user-admin',
          overwrite: true,
          now: new Date('2026-01-01T01:10:00.000Z'),
        }),
        /overwrite restore update failed/
      );
      assert.equal(await exists(path.join(dataRoot, overwriteEntry.trashRelativePath)), true);
      assert.equal(
        await fs.readFile(path.join(workspaceRoot, 'docs', 'overwrite.md'), 'utf8'),
        '# Existing destination\n'
      );
    } finally {
      execSqlite(dataRoot, 'DROP TRIGGER IF EXISTS fail_workspace_trash_overwrite_restore_update;');
    }

    const overwriteRestored = await restoreWorkspaceTrashEntry({
      workspace,
      entryId: overwriteEntry.id,
      restoredByUserId: 'user-admin',
      overwrite: true,
      now: new Date('2026-01-01T01:15:00.000Z'),
    });
    assert.equal(overwriteRestored.status, 'restored');
    assert.equal(await exists(path.join(dataRoot, overwriteEntry.trashRelativePath)), false);
    assert.equal(await fs.readFile(path.join(workspaceRoot, 'docs', 'overwrite.md'), 'utf8'), '# Replacement\n');

    const pagedTrash = await listWorkspaceTrashEntries({ workspace, limit: 1 });
    assert.equal(pagedTrash.length, 1);

    const archiveEntry = trashed.trashed.find((entry) => entry.originalPath === 'docs/archive');
    assert.ok(archiveEntry);
    execSqlite(dataRoot, `
      CREATE TRIGGER fail_workspace_trash_purge_update
      BEFORE UPDATE OF status ON workspace_trash_entries
      WHEN NEW.status = 'purged'
      BEGIN
        SELECT RAISE(FAIL, 'purge update failed');
      END;
    `);
    try {
      const failedPurge = await purgeExpiredWorkspaceTrash({
        now: new Date('2026-01-03T00:00:00.000Z'),
        purgedByUserId: 'system-cleanup',
      });
      assert.equal(failedPurge.purged.length, 0);
      assert.equal(failedPurge.failed.length, 3);
      assert.equal(await exists(path.join(dataRoot, mixedBatch.trashed[0].trashRelativePath)), true);
      assert.equal(await exists(path.join(dataRoot, symlinkBatch.trashed[0].trashRelativePath)), true);
      assert.equal(await exists(path.join(dataRoot, archiveEntry.trashRelativePath)), true);
    } finally {
      execSqlite(dataRoot, 'DROP TRIGGER IF EXISTS fail_workspace_trash_purge_update;');
    }

    const purge = await purgeExpiredWorkspaceTrash({
      now: new Date('2026-01-03T00:00:00.000Z'),
      purgedByUserId: 'system-cleanup',
    });
    assert.equal(purge.failed.length, 0);
    assert.equal(purge.purged.length, 3);

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
        { originalPath: 'docs/links', status: 'purged' },
        { originalPath: 'docs/mixed-valid.md', status: 'purged' },
        { originalPath: 'docs/overwrite.md', status: 'restored' },
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
