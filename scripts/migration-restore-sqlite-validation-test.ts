import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import {
  DEFAULT_MIGRATION_COMPONENTS,
  MIGRATION_BUNDLE_SCHEMA_VERSION,
  type CanvasMigrationManifest,
  type PendingMigrationRestore,
} from '../app/lib/migration/types';

const execFileAsync = promisify(execFile);

async function createZipArchive(root: string, name: string, manifest: CanvasMigrationManifest, files: Record<string, string | Buffer>): Promise<string> {
  const bundleDir = path.join(root, name);
  await mkdir(bundleDir, { recursive: true });
  await writeFile(path.join(bundleDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(bundleDir, ...relativePath.split('/'));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  const archivePath = path.join(root, `${name}.zip`);
  await execFileAsync('zip', ['-qr', archivePath, '.'], { cwd: bundleDir });
  return archivePath;
}

async function seedTargetDatabase(dataRoot: string): Promise<void> {
  const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
  try {
    runMigrations(sqlite);
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO user (id, name, email, email_verified, role, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'admin', ?, ?)
    `).run('user-target', 'Target Admin', 'admin@example.test', now, now);
  } finally {
    sqlite.close();
  }
}

function assertTargetDatabaseStillReadable(dataRoot: string): void {
  const sqlite = new Database(path.join(dataRoot, 'sqlite.db'), { readonly: true, fileMustExist: true });
  try {
    const check = sqlite.prepare('PRAGMA quick_check').get() as { quick_check?: string };
    assert.equal(check.quick_check, 'ok');
    const users = sqlite.prepare('SELECT COUNT(*) AS count FROM user WHERE id = ?').get('user-target') as { count: number };
    assert.equal(users.count, 1);
  } finally {
    sqlite.close();
  }
}

async function main(): Promise<void> {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-migration-restore-data-'));
  const archiveRoot = await mkdtemp(path.join(tmpdir(), 'canvas-migration-restore-archive-'));
  try {
    await mkdir(path.join(dataRoot, 'workspace'), { recursive: true });
    await writeFile(path.join(dataRoot, 'workspace', 'current.md'), '# Current\n');
    await seedTargetDatabase(dataRoot);

    const manifest: CanvasMigrationManifest = {
      format: 'canvas-notebook-migration',
      bundleSchemaVersion: MIGRATION_BUNDLE_SCHEMA_VERSION,
      appVersion: '2026.7.3.1',
      exportedAt: new Date().toISOString(),
      exportId: 'invalid-sqlite-restore',
      exportProfile: 'standard',
      components: {
        ...DEFAULT_MIGRATION_COMPONENTS,
        studioAssets: false,
        studioOutputs: false,
        userUploads: false,
        agents: false,
        skills: false,
        secrets: false,
      },
      source: {
        databaseProvider: 'sqlite',
        deploymentMode: 'single_user',
        teamFeaturesEnabled: false,
        managedServicesEnabled: false,
        organizationId: null,
        createdByUserId: 'user-target',
        createdByEmail: 'admin@example.test',
        createdByRole: 'admin',
      },
      database: {
        provider: 'sqlite',
        logicalSchemaVersion: null,
        migrationVersion: MIGRATION_BUNDLE_SCHEMA_VERSION,
        backupKind: 'sqlite_snapshot',
        artifactPath: 'data/sqlite.db',
        artifactSha256: null,
        pgvectorEnabled: null,
        pgvectorVersion: null,
        postgresVersion: null,
      },
      features: {
        teamWorkspaceEnabled: false,
        knowledgeEnabled: false,
        embeddingsEnabled: false,
        collaborationEnabled: false,
      },
      restore: {
        requiresPostgres: false,
        requiresReindex: false,
        preservesTargetInstanceAndLicense: true,
        publicLinksIncluded: false,
      },
      fileCount: 2,
      totalBytes: 2,
      warnings: [],
      files: [
        { component: 'workspace', archivePath: 'data/workspace/restored.md', size: 1, modifiedAt: new Date().toISOString() },
        { component: 'database', archivePath: 'data/sqlite.db', size: 1, modifiedAt: new Date().toISOString() },
      ],
    };

    const archivePath = await createZipArchive(archiveRoot, 'invalid-sqlite-restore', manifest, {
      'data/workspace/restored.md': '# Restored\n',
      'data/sqlite.db': 'not a sqlite database',
    });
    const pending: PendingMigrationRestore = {
      id: 'invalid-sqlite-restore',
      uploadId: 'upload-invalid-sqlite',
      archivePath,
      requestedAt: new Date().toISOString(),
      requestedBy: {
        userId: 'user-target',
        email: 'admin@example.test',
      },
      components: manifest.components,
      invalidateSessions: true,
      pauseAutomations: true,
      clearOAuthTokens: true,
      preserveTargetInstanceAndLicense: true,
    };
    await mkdir(path.join(dataRoot, '.migration'), { recursive: true });
    await writeFile(path.join(dataRoot, '.migration', 'pending-restore.json'), `${JSON.stringify(pending, null, 2)}\n`);

    let failed = false;
    try {
      await execFileAsync('npx', ['tsx', 'scripts/apply-pending-migration-restore.ts'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATA: dataRoot,
        },
        encoding: 'utf8',
      });
    } catch (error) {
      failed = true;
      const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : String(error);
      assert.match(stderr, /SQLite database at .* is not readable|file is not a database/u);
    }

    assert.equal(failed, true);
    assertTargetDatabaseStillReadable(dataRoot);
    assert.equal(await readFile(path.join(dataRoot, 'workspace', 'current.md'), 'utf8'), '# Current\n');
    await assert.rejects(() => readFile(path.join(dataRoot, 'workspace', 'restored.md'), 'utf8'), /ENOENT/u);

    console.log('migration-restore-sqlite-validation-test: ok');
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
    await rm(archiveRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
