import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

import { DEFAULT_MIGRATION_COMPONENTS, type MigrationComponents } from '../app/lib/migration/types';

const execFileAsync = promisify(execFile);

async function unzipList(archivePath: string): Promise<string> {
  const { stdout } = await execFileAsync('unzip', ['-Z1', archivePath], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout;
}

async function unzipEntryText(archivePath: string, entry: string): Promise<string> {
  const { stdout } = await execFileAsync('unzip', ['-p', archivePath, entry], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  return stdout;
}

async function unzipEntryToFile(archivePath: string, entry: string, targetPath: string): Promise<void> {
  const { stdout } = await execFileAsync('unzip', ['-p', archivePath, entry], {
    encoding: 'buffer',
    maxBuffer: 100 * 1024 * 1024,
  });
  await writeFile(targetPath, stdout);
}

async function waitForExport(
  getMigrationExportJob: (id: string) => Promise<{ status: string; filePath?: string; error?: string } | null>,
  exportId: string,
) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const job = await getMigrationExportJob(exportId);
    if (job?.status === 'completed') return job;
    if (job?.status === 'failed') throw new Error(job.error || 'export failed');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for export ${exportId}`);
}

async function main() {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-migration-export-policy-'));
  const previousData = process.env.DATA;
  const previousCanvasDataRoot = process.env.CANVAS_DATA_ROOT;
  const previousDatabaseProvider = process.env.CANVAS_DATABASE_PROVIDER;
  const previousDeploymentMode = process.env.CANVAS_DEPLOYMENT_MODE;

  process.env.DATA = dataRoot;
  process.env.CANVAS_DATA_ROOT = dataRoot;
  process.env.CANVAS_DATABASE_PROVIDER = 'sqlite';
  process.env.CANVAS_DEPLOYMENT_MODE = 'team';

  try {
    await mkdir(path.join(dataRoot, 'workspace'), { recursive: true });
    await mkdir(path.join(dataRoot, 'workspaces', 'team', 'org-export', 'files'), { recursive: true });
    await mkdir(path.join(dataRoot, 'workspaces', 'personal', 'user-export', 'files'), { recursive: true });
    await mkdir(path.join(dataRoot, 'secrets'), { recursive: true });
    await writeFile(path.join(dataRoot, 'workspace', 'legacy.md'), '# Legacy\n');
    await writeFile(path.join(dataRoot, 'workspaces', 'team', 'org-export', 'files', 'team.md'), '# Team\n');
    await writeFile(path.join(dataRoot, 'workspaces', 'personal', 'user-export', 'files', 'private.md'), '# Private\n');
    await writeFile(path.join(dataRoot, 'secrets', 'Canvas-Integrations.env'), 'OPENAI_API_KEY=sk-secret\nCOMPOSIO_API_KEY=secret\n');

    const sqlite = new Database(path.join(dataRoot, 'sqlite.db'));
    try {
      sqlite.exec(`
        CREATE TABLE public_file_shares (id TEXT PRIMARY KEY, token TEXT, token_hash TEXT, status TEXT);
        CREATE TABLE session (id TEXT PRIMARY KEY, token TEXT);
        CREATE TABLE verification (id TEXT PRIMARY KEY, identifier TEXT, value TEXT);
        CREATE TABLE account (
          id TEXT PRIMARY KEY,
          access_token TEXT,
          refresh_token TEXT,
          id_token TEXT,
          access_token_expires_at INTEGER,
          refresh_token_expires_at INTEGER,
          password TEXT
        );
        CREATE TABLE oauth_tokens (id TEXT PRIMARY KEY, provider TEXT, access_token TEXT, refresh_token TEXT);
        CREATE TABLE channel_link_tokens (id INTEGER PRIMARY KEY, token TEXT);
        CREATE TABLE todo_email_reply_watchers (id TEXT PRIMARY KEY, reply_token TEXT);
        CREATE TABLE todo_email_reply_events (id TEXT PRIMARY KEY, watcher_id TEXT);
        CREATE TABLE composio_webhook_subscriptions (
          id TEXT PRIMARY KEY,
          encrypted_secret TEXT NOT NULL,
          secret_preview TEXT,
          status TEXT NOT NULL
        );
        CREATE TABLE automation_webhook_triggers (
          id TEXT PRIMARY KEY,
          secret_hash TEXT NOT NULL,
          secret_preview TEXT NOT NULL,
          status TEXT NOT NULL
        );

        INSERT INTO public_file_shares VALUES ('share-1', 'public-token', 'hash', 'active');
        INSERT INTO session VALUES ('session-1', 'session-token');
        INSERT INTO verification VALUES ('verification-1', 'email', 'verification-token');
        INSERT INTO account VALUES ('account-1', 'access-token', 'refresh-token', 'id-token', 1, 2, 'password-secret');
        INSERT INTO oauth_tokens VALUES ('oauth-1', 'pi', 'oauth-access', 'oauth-refresh');
        INSERT INTO channel_link_tokens VALUES (1, 'channel-token');
        INSERT INTO todo_email_reply_watchers VALUES ('watcher-1', 'reply-token');
        INSERT INTO todo_email_reply_events VALUES ('event-1', 'watcher-1');
        INSERT INTO composio_webhook_subscriptions VALUES ('sub-1', 'encrypted-secret', 'sec...', 'active');
        INSERT INTO automation_webhook_triggers VALUES ('trigger-1', 'secret-hash', 'sec...', 'active');
      `);
    } finally {
      sqlite.close();
    }

    const {
      createMigrationExportJob,
      getMigrationExportJob,
    } = await import('../app/lib/migration/export-service');

    const components: MigrationComponents = {
      ...DEFAULT_MIGRATION_COMPONENTS,
      studioAssets: false,
      studioOutputs: false,
      userUploads: false,
      agents: false,
      skills: false,
      secrets: true,
    };

    const standardJob = await createMigrationExportJob({
      components,
      profile: 'standard',
      includePersonalWorkspaces: true,
      source: {
        organizationId: 'org-export',
        createdByUserId: 'user-admin',
        createdByEmail: 'admin@example.test',
        createdByRole: 'admin',
      },
    });
    const completedStandard = await waitForExport(getMigrationExportJob, standardJob.id);
    assert.ok(completedStandard.filePath);

    const entries = (await unzipList(completedStandard.filePath!))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    assert.ok(entries.includes('manifest.json'));
    assert.ok(entries.includes('data/sqlite.db'));
    assert.ok(entries.includes('data/workspace/legacy.md'));
    assert.ok(entries.includes('data/workspaces/team/org-export/files/team.md'));
    assert.equal(entries.includes('data/workspaces/personal/user-export/files/private.md'), false);
    assert.equal(entries.includes('data/secrets/Canvas-Integrations.env'), false);
    assert.ok(entries.includes('data/reconnect-manifest.json'));

    const manifest = JSON.parse(await unzipEntryText(completedStandard.filePath!, 'manifest.json'));
    assert.equal(manifest.exportProfile, 'standard');
    assert.equal(manifest.selection.includePersonalWorkspaces, false);
    assert.equal(manifest.selection.includePublicLinks, false);
    assert.equal(manifest.selection.includeRawSecrets, false);
    assert.equal(manifest.security.publicLinksIncluded, false);
    assert.equal(manifest.security.publicLinkTokensIncluded, false);
    assert.equal(manifest.security.rawSecretsIncluded, false);
    assert.equal(manifest.security.secretsMode, 'reconnect_manifest');
    assert.equal(manifest.source.organizationId, 'org-export');
    assert.equal(manifest.source.createdByUserId, 'user-admin');

    const reconnectManifest = JSON.parse(await unzipEntryText(completedStandard.filePath!, 'data/reconnect-manifest.json'));
    assert.equal(reconnectManifest.rawSecretsIncluded, false);
    assert.ok(JSON.stringify(reconnectManifest).includes('OPENAI_API_KEY'));
    assert.equal(JSON.stringify(reconnectManifest).includes('sk-secret'), false);

    const snapshotPath = path.join(dataRoot, 'snapshot-check.sqlite.db');
    await unzipEntryToFile(completedStandard.filePath!, 'data/sqlite.db', snapshotPath);
    const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try {
      assert.equal((snapshot.prepare('SELECT COUNT(*) AS count FROM public_file_shares').get() as { count: number }).count, 0);
      assert.equal((snapshot.prepare('SELECT COUNT(*) AS count FROM session').get() as { count: number }).count, 0);
      assert.equal((snapshot.prepare('SELECT COUNT(*) AS count FROM verification').get() as { count: number }).count, 0);
      assert.equal((snapshot.prepare('SELECT COUNT(*) AS count FROM oauth_tokens').get() as { count: number }).count, 0);
      assert.equal((snapshot.prepare('SELECT COUNT(*) AS count FROM channel_link_tokens').get() as { count: number }).count, 0);
      assert.equal((snapshot.prepare('SELECT COUNT(*) AS count FROM todo_email_reply_watchers').get() as { count: number }).count, 0);
      const account = snapshot.prepare('SELECT access_token AS accessToken, refresh_token AS refreshToken, id_token AS idToken, password FROM account').get() as {
        accessToken: string | null;
        refreshToken: string | null;
        idToken: string | null;
        password: string | null;
      };
      assert.deepEqual(account, { accessToken: null, refreshToken: null, idToken: null, password: null });
      assert.deepEqual(
        snapshot.prepare('SELECT encrypted_secret AS encryptedSecret, secret_preview AS secretPreview, status FROM composio_webhook_subscriptions').get(),
        { encryptedSecret: 'redacted', secretPreview: 'redacted', status: 'paused' },
      );
      assert.deepEqual(
        snapshot.prepare('SELECT secret_preview AS secretPreview, status FROM automation_webhook_triggers').get(),
        { secretPreview: 'redacted', status: 'paused' },
      );
    } finally {
      snapshot.close();
    }

    const fullAdminJob = await createMigrationExportJob({
      components: {
        ...components,
        database: false,
        secrets: false,
      },
      profile: 'full_admin',
      includePersonalWorkspaces: true,
    });
    const completedFullAdmin = await waitForExport(getMigrationExportJob, fullAdminJob.id);
    const fullAdminEntries = (await unzipList(completedFullAdmin.filePath!))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    assert.ok(fullAdminEntries.includes('data/workspaces/personal/user-export/files/private.md'));

    console.log('migration-export-policy-test: ok');
  } finally {
    if (previousData === undefined) delete process.env.DATA;
    else process.env.DATA = previousData;
    if (previousCanvasDataRoot === undefined) delete process.env.CANVAS_DATA_ROOT;
    else process.env.CANVAS_DATA_ROOT = previousCanvasDataRoot;
    if (previousDatabaseProvider === undefined) delete process.env.CANVAS_DATABASE_PROVIDER;
    else process.env.CANVAS_DATABASE_PROVIDER = previousDatabaseProvider;
    if (previousDeploymentMode === undefined) delete process.env.CANVAS_DEPLOYMENT_MODE;
    else process.env.CANVAS_DEPLOYMENT_MODE = previousDeploymentMode;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
