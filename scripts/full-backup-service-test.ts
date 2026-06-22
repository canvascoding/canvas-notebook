import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);

async function unzipList(archivePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync('unzip', ['-Z1', archivePath], {
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  });
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

async function unzipEntryText(archivePath: string, entry: string): Promise<string> {
  const { stdout } = await execFileAsync('unzip', ['-p', archivePath, entry], {
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  });
  return stdout;
}

async function unzipEntryBuffer(archivePath: string, entry: string): Promise<Buffer> {
  const { stdout } = await execFileAsync('unzip', ['-p', archivePath, entry], {
    encoding: 'buffer',
    maxBuffer: 100 * 1024 * 1024,
  });
  return stdout;
}

async function waitForBackup(
  getFullBackupJob: (id: string) => Promise<{ status: string; filePath?: string; error?: string } | null>,
  backupId: string,
) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const job = await getFullBackupJob(backupId);
    if (job?.status === 'completed') return job;
    if (job?.status === 'failed') throw new Error(job.error || 'backup failed');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for backup ${backupId}`);
}

async function main() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-full-backup-'));
  const previousData = process.env.DATA;
  const previousCanvasDataRoot = process.env.CANVAS_DATA_ROOT;
  const previousDatabaseProvider = process.env.CANVAS_DATABASE_PROVIDER;
  const previousDeploymentMode = process.env.CANVAS_DEPLOYMENT_MODE;
  const previousTeamFeatures = process.env.CANVAS_TEAM_FEATURES_ENABLED;

  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.CANVAS_DEPLOYMENT_MODE = 'managed-team';
  process.env.CANVAS_TEAM_FEATURES_ENABLED = 'true';

  try {
    await mkdir(path.join(dataRoot, 'workspaces', 'team', 'org-backup', 'files'), { recursive: true });
    await mkdir(path.join(dataRoot, 'workspaces', 'personal', 'user-backup', 'files'), { recursive: true });
    await mkdir(path.join(dataRoot, 'secrets'), { recursive: true });
    await mkdir(path.join(dataRoot, 'system', 'backups', 'old-backup'), { recursive: true });
    await writeFile(path.join(dataRoot, 'workspaces', 'team', 'org-backup', 'files', 'team.md'), '# Team\n');
    await writeFile(path.join(dataRoot, 'workspaces', 'personal', 'user-backup', 'files', 'private.md'), '# Private\n');
    await writeFile(path.join(dataRoot, 'secrets', 'Canvas-Integrations.env'), 'OPENAI_API_KEY=sk-secret\n');
    await writeFile(path.join(dataRoot, 'system', 'backups', 'old-backup', 'do-not-include.txt'), 'recursive backup\n');

    const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
    try {
      sqlite.exec(`
        CREATE TABLE public_file_shares (id TEXT PRIMARY KEY, token TEXT, token_hash TEXT, status TEXT);
        CREATE TABLE oauth_tokens (id TEXT PRIMARY KEY, provider TEXT, access_token TEXT, refresh_token TEXT);
        INSERT INTO public_file_shares VALUES ('share-1', 'public-token', 'hash', 'active');
        INSERT INTO oauth_tokens VALUES ('oauth-1', 'pi', 'oauth-access', 'oauth-refresh');
      `);
    } finally {
      sqlite.close();
    }

    const {
      createFullBackupJob,
      getFullBackupJob,
      inspectFullBackupArchive,
    } = await import('../app/lib/backups/full-backup-service');
    const {
      serializeFullBackupInspection,
      serializeFullBackupJob,
    } = await import('../app/lib/backups/serialize');

    const job = await createFullBackupJob({
      source: {
        organizationId: 'org-backup',
        createdByUserId: 'user-admin',
        createdByEmail: 'admin@example.test',
        createdByRole: 'admin',
      },
    });
    const completed = await waitForBackup(getFullBackupJob, job.id);
    assert.ok(completed.filePath);
    const completedJob = await getFullBackupJob(job.id);
    assert.ok(completedJob);
    assert.equal('filePath' in serializeFullBackupJob(completedJob), false);

    const entries = await unzipList(completed.filePath);
    assert.ok(entries.includes('manifest.json'));
    assert.ok(entries.includes('database/sqlite.db'));
    assert.ok(entries.includes('data/workspaces/team/org-backup/files/team.md'));
    assert.ok(entries.includes('data/workspaces/personal/user-backup/files/private.md'));
    assert.ok(entries.includes('data/secrets/Canvas-Integrations.env'));
    assert.equal(entries.some((entry) => entry.includes('do-not-include.txt')), false);
    assert.equal(entries.includes('data/sqlite.db'), false);

    const manifest = JSON.parse(await unzipEntryText(completed.filePath, 'manifest.json'));
    assert.equal(manifest.format, 'canvas-notebook-full-backup');
    assert.equal(manifest.database.provider, 'sqlite');
    assert.equal(manifest.database.backupKind, 'sqlite_snapshot');
    assert.equal(manifest.security.rawSecretsIncluded, true);
    assert.equal(manifest.security.publicLinkTokensIncluded, true);
    assert.equal(manifest.security.unencryptedArchive, true);
    assert.equal(manifest.source.organizationId, 'org-backup');
    assert.equal(manifest.files.some((file: Record<string, unknown>) => typeof file.filePath === 'string'), false);
    assert.ok(manifest.warnings.some((warning: string) => warning.includes('not automatically encrypted')));

    const sqliteBytes = await unzipEntryBuffer(completed.filePath, 'database/sqlite.db');
    assert.equal(createHash('sha256').update(sqliteBytes).digest('hex'), manifest.database.artifactSha256);
    const snapshotPath = path.join(dataRoot, 'snapshot-check.sqlite.db');
    await writeFile(snapshotPath, sqliteBytes);
    const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try {
      assert.equal((snapshot.prepare('SELECT COUNT(*) AS count FROM public_file_shares').get() as { count: number }).count, 1);
      assert.equal((snapshot.prepare('SELECT COUNT(*) AS count FROM oauth_tokens').get() as { count: number }).count, 1);
    } finally {
      snapshot.close();
    }

    const inspection = await inspectFullBackupArchive(completed.filePath);
    assert.equal(inspection.canRestore, true);
    assert.equal(inspection.backupId, job.id);
    assert.equal(inspection.sourceDatabaseProvider, 'sqlite');
    assert.ok(inspection.warnings.some((warning) => warning.includes('unencrypted')));
    assert.equal('archivePath' in serializeFullBackupInspection(inspection), false);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const lockPath = path.join(dataRoot, 'system', 'backups', '.full-backup.lock');
    await writeFile(lockPath, `${JSON.stringify({
      backupId: randomUUID(),
      createdAt: new Date().toISOString(),
      pid: process.pid,
    })}\n`);
    await assert.rejects(
      () => createFullBackupJob(),
      /already running/u,
    );
    await rm(lockPath, { force: true });

    const staleBackupId = randomUUID();
    const staleCreatedAt = new Date().toISOString();
    await mkdir(path.join(dataRoot, 'system', 'backups', staleBackupId), { recursive: true });
    await writeFile(path.join(dataRoot, 'system', 'backups', staleBackupId, 'status.json'), `${JSON.stringify({
      id: staleBackupId,
      status: 'running',
      phase: 'Writing archive',
      createdAt: staleCreatedAt,
      updatedAt: staleCreatedAt,
      fileName: 'stale.zip',
      source: {
        databaseProvider: 'sqlite',
        deploymentMode: 'managed-team',
        teamFeaturesEnabled: true,
        managedServicesEnabled: false,
        organizationId: 'org-backup',
        createdByUserId: 'user-admin',
        createdByEmail: 'admin@example.test',
        createdByRole: 'admin',
      },
      progress: {
        fileCount: 1,
        totalBytes: 1,
        filesProcessed: 0,
        bytesProcessed: 0,
      },
    }, null, 2)}\n`);
    await writeFile(lockPath, `${JSON.stringify({
      backupId: staleBackupId,
      createdAt: staleCreatedAt,
      pid: 999999,
    })}\n`);

    const replacementJob = await createFullBackupJob({
      source: {
        organizationId: 'org-backup',
        createdByUserId: 'user-admin',
        createdByEmail: 'admin@example.test',
        createdByRole: 'admin',
      },
    });
    const replacementCompleted = await waitForBackup(getFullBackupJob, replacementJob.id);
    assert.ok(replacementCompleted.filePath);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const staleJob = JSON.parse(await readFile(path.join(dataRoot, 'system', 'backups', staleBackupId, 'status.json'), 'utf8'));
    assert.equal(staleJob.status, 'failed');
    assert.match(staleJob.error, /stale/u);
    assert.equal(await stat(lockPath).then(() => true).catch(() => false), false);

    assert.ok((await stat(completed.filePath)).size > 0);

    console.log('full-backup-service-test: ok');
  } finally {
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    if (previousCanvasDataRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousCanvasDataRoot;
    if (previousDatabaseProvider === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
    else process.env.CANVAS_DATABASE_PROVIDER = previousDatabaseProvider;
    if (previousDeploymentMode === undefined) delete process.env.CANVAS_DEPLOYMENT_MODE;
    else process.env.CANVAS_DEPLOYMENT_MODE = previousDeploymentMode;
    if (previousTeamFeatures === undefined) delete process.env.CANVAS_TEAM_FEATURES_ENABLED;
    else process.env.CANVAS_TEAM_FEATURES_ENABLED = previousTeamFeatures;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
