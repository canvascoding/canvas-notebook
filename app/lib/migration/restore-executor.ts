import 'server-only';

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Client } from 'pg';
import { isBootstrapAdminEmail } from '@/app/lib/bootstrap-admin';
import { getMigrationDataRoot, getMigrationRoot, getMigrationUploadsRoot, getPendingRestorePath, ensureMigrationDir } from './paths';
import { inspectMigrationArchive } from './inspect-service';
import { migrationFileSha256, openMigrationArchive, stageMigrationEntry } from './archive';
import { buildRestoreFilePlan, resolveRestoreTarget } from './restore-plan';
import { migrationTargetFingerprint, readMigrationJson, writeMigrationJson } from './restore-storage';
import { prepareRestoreFileJournal, publishRestoreFiles, resetRestoreOAuthFiles,
  restoreJournalPath, rollbackRestoreFiles, saveRestoreJournal, type RestoreJournal } from './restore-files';
import { isPortableRuntimeConfigPath, redactPortableRuntimeConfig } from './secret-export-policy';
import type { MigrationRestoreResult, PendingMigrationRestore } from './types';
import { resetMigrationSecrets } from './restore-secrets';

export function migrationRestoreResultPath(): string { return path.join(getMigrationRoot(), 'last-restore.json'); }

async function finishRestore(client: Client, pending: PendingMigrationRestore, journal: RestoreJournal): Promise<MigrationRestoreResult> {
  // This transaction is idempotent. A crash after file publication retries these
  // actions before boot; it never serves a mixture of old and new files.
  await client.query('BEGIN');
  try {
    await client.query('DELETE FROM "session"');
    await client.query("UPDATE automation_jobs SET status='paused' WHERE status='active'");
    await client.query('UPDATE account SET access_token=NULL, refresh_token=NULL, id_token=NULL');
    const oauth = await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'oauth_%' OR tablename IN ('verification','jwks'))");
    if (oauth.rows.length) {
      const names = oauth.rows.map(row => {
        if (!/^[a-z_][a-z0-9_]*$/u.test(row.tablename)) throw new Error('Unexpected OAuth storage table.');
        return '"' + row.tablename + '"';
      });
      await client.query('TRUNCATE ' + names.join(',') + ' CASCADE');
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  const result: MigrationRestoreResult = { id: pending.id, status: 'completed', completedAt: new Date().toISOString(),
    filesApplied: journal.files.length, rollbackComplete: false };
  await writeMigrationJson(migrationRestoreResultPath(), result);
  await fs.rm(getPendingRestorePath(), { force: true });
  await fs.rm(restoreJournalPath(), { force: true });
  await fs.rm(path.join(getMigrationRoot(), 'restores', pending.id), { recursive: true, force: true });
  return result;
}

async function rejectRestore(pending: PendingMigrationRestore, journal: RestoreJournal | null, error: unknown): Promise<MigrationRestoreResult> {
  if (journal?.phase === 'files_applied') throw new Error('Restore cleanup is incomplete. Restart to finish recovery before serving requests.', { cause: error });
  if (journal) await rollbackRestoreFiles(getMigrationDataRoot(), journal);
  const result: MigrationRestoreResult = { id: pending.id, status: 'failed', completedAt: new Date().toISOString(),
    filesApplied: 0, rollbackComplete: true, error: error instanceof Error ? error.message : 'Restore failed.' };
  await writeMigrationJson(migrationRestoreResultPath(), result);
  await fs.rename(getPendingRestorePath(), path.join(getMigrationRoot(), `failed-restore-${pending.id}.json`));
  await fs.rm(restoreJournalPath(), { force: true });
  return result;
}

/** Runs once, offline, before the application imports auth or opens HTTP/WebSockets. */
export async function applyPendingMigrationRestore(): Promise<MigrationRestoreResult | null> {
  const pending = await readMigrationJson<PendingMigrationRestore>(getPendingRestorePath());
  let journal = await readMigrationJson<RestoreJournal>(restoreJournalPath());
  if (!pending && !journal) return null;
  if (!pending || !/^[a-f0-9-]{36}$/iu.test(pending.id) || (journal && journal.id !== pending.id)) throw new Error('Restore recovery state is inconsistent.');
  if (!pending.targetFingerprint || await migrationTargetFingerprint() !== pending.targetFingerprint) {
    if (journal) throw new Error('The restore recovery target changed. Recovery must run on the originally approved target.');
    return rejectRestore(pending, null, new Error('The approved restore target changed. Upload and approve the archive on the intended target again.'));
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext('canvas-notebook-migration-restore')) AS locked");
    if (!lock.rows[0]?.locked) throw new Error('Another migration restore is already running for this database.');
    if (journal?.phase === 'files_applied') return await finishRestore(client, pending, journal);
    if (journal) {
      // An interrupted publish is compensated, never guessed to be successful.
      return await rejectRestore(pending, journal, new Error('Interrupted file restore was rolled back. Upload and inspect again.'));
    }
    try {
      if (pending.preserveTargetInstanceAndLicense !== true || pending.invalidateSessions !== true
        || pending.pauseAutomations !== true || pending.clearOAuthTokens !== true) throw new Error('Invalid restore safety policy.');
      const actor = await client.query<{ role: string | null; email: string; banned: string | number | boolean | null }>('SELECT role,email,banned FROM "user" WHERE id=$1', [pending.requestedBy.userId]);
      const user = actor.rows[0];
      if (!user || user.banned === true || Number(user.banned) === 1
        || !(user.role === 'admin' || isBootstrapAdminEmail(user.email))) throw new Error('The administrator who approved this restore no longer has access.');
      const archivePath = await fs.realpath(pending.archivePath);
      const uploadsRoot = await fs.realpath(getMigrationUploadsRoot());
      if (!archivePath.startsWith(uploadsRoot + path.sep) || !pending.archiveSha256
        || !/^[a-f0-9]{64}$/u.test(pending.archiveSha256)
        || await migrationFileSha256(archivePath) !== pending.archiveSha256) throw new Error('Approved restore archive checksum is missing or changed. Upload and inspect again.');
      const inspection = await inspectMigrationArchive({ uploadId: pending.uploadId, archivePath, mappings: pending.mappings });
      if (!inspection.canRestore || !inspection.manifest || !inspection.dryRun) throw new Error('The restore no longer passes inspection and mapping validation.');
      if (inspection.manifest.components.database) throw new Error('Database restore is not available for this archive format.');
      const dataRoot = getMigrationDataRoot();
      const entries = await openMigrationArchive(archivePath);
      const plan = buildRestoreFilePlan({ dataRoot, manifest: inspection.manifest, entries, mappings: inspection.dryRun.workspaces });
      const stageRoot = path.join(getMigrationRoot(), 'restores', pending.id, 'staged');
      await ensureMigrationDir(stageRoot);
      const publications: Array<{ target: string; staged: string; workspaceId: string | null; workspacePath: string | null }> = [];
      for (const [index, file] of plan.files.entries()) {
        const staged = path.join(stageRoot, String(index));
        await stageMigrationEntry(file.zip, staged, file.source.sha256);
        if (!file.target) continue;
        const target = resolveRestoreTarget(dataRoot, file.target);
        if (isPortableRuntimeConfigPath(target, dataRoot)) {
          const raw = await fs.readFile(staged, 'utf8');
          if (redactPortableRuntimeConfig(raw, target, dataRoot) !== raw) throw new Error('Runtime credentials must be removed before portable migration. Export with the current application.');
        }
        publications.push({ target: file.target, staged: path.relative(dataRoot, staged).split(path.sep).join('/'),
          workspaceId: file.workspaceId, workspacePath: file.workspacePath });
      }
      if (await migrationFileSha256(archivePath) !== pending.archiveSha256) throw new Error('Restore archive changed while staging.');
      journal = await prepareRestoreFileJournal({ id: pending.id, dataRoot, files: publications, directories: plan.directories });
      await publishRestoreFiles(dataRoot, journal);
      await resetMigrationSecrets(client, dataRoot, journal);
      await resetRestoreOAuthFiles(dataRoot, journal);
      journal.phase = 'files_applied'; await saveRestoreJournal(journal);
      return await finishRestore(client, pending, journal);
    } catch (error) { return await rejectRestore(pending, journal, error); }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('canvas-notebook-migration-restore'))").catch(() => undefined);
    await client.end();
  }
}
