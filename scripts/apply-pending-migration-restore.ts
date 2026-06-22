import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import Database from 'better-sqlite3';

import { runMigrations } from '../app/lib/db/migrate';
import type {
  CanvasMigrationManifest,
  MigrationComponents,
  PendingMigrationRestore,
} from '../app/lib/migration/types';
import {
  getSelectedMigrationComponentPaths,
  resolveMigrationDataPath,
} from '../app/lib/migration/component-paths';

const execFileAsync = promisify(execFile);

function getDataRoot(): string {
  const configured = process.env.DATA?.trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }
  return '/data';
}

const DATA_ROOT = getDataRoot();
const MIGRATION_ROOT = path.join(DATA_ROOT, '.migration');
const PENDING_RESTORE_PATH = path.join(MIGRATION_ROOT, 'pending-restore.json');
const BACKUP_ROOT = path.join(DATA_ROOT, '.restore-backups');

function log(message: string) {
  console.log(`[migration-restore] ${message}`);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

async function writeJsonPrivate(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

async function unzipText(args: string[], maxBuffer = 100 * 1024 * 1024): Promise<string> {
  const { stdout } = await execFileAsync('unzip', args, { encoding: 'utf8', maxBuffer });
  return stdout;
}

function hasUnsafeZipEntry(entryName: string): boolean {
  if (!entryName || entryName.includes('\0')) return true;
  if (entryName.startsWith('/') || entryName.startsWith('\\')) return true;
  const normalized = entryName.replace(/\\/g, '/');
  return normalized.split('/').some((part) => part === '..') ||
    (!normalized.startsWith('data/') && normalized !== 'manifest.json');
}

async function validateArchive(archivePath: string): Promise<CanvasMigrationManifest> {
  const listing = await unzipText(['-Z1', archivePath]);
  const entries = listing.split('\n').map((line) => line.trim()).filter(Boolean);
  const unsafeEntry = entries.find(hasUnsafeZipEntry);
  if (unsafeEntry) {
    throw new Error(`Archive contains unsafe entry: ${unsafeEntry}`);
  }

  const rawManifest = await unzipText(['-p', archivePath, 'manifest.json'], 20 * 1024 * 1024);
  const manifest = JSON.parse(rawManifest) as CanvasMigrationManifest;
  if (manifest.format !== 'canvas-notebook-migration' || !manifest.components) {
    throw new Error('Archive manifest is not a Canvas migration manifest.');
  }
  const sourceProvider = manifest.database?.provider ?? manifest.source?.databaseProvider ?? 'sqlite';
  if (manifest.components.database && sourceProvider !== 'sqlite') {
    throw new Error(`Database restore for provider ${sourceProvider} is not supported by this migration restore script.`);
  }
  return manifest;
}

async function ensureNoSymlinks(rootPath: string): Promise<void> {
  if (!await pathExists(rootPath)) return;
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    const stats = await fs.lstat(entryPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Archive extraction produced a symbolic link: ${entryPath}`);
    }
    if (stats.isDirectory()) {
      await ensureNoSymlinks(entryPath);
    }
  }
}

async function backupPath(targetPath: string, backupDir: string): Promise<void> {
  if (!await pathExists(targetPath)) return;
  const relative = path.relative(DATA_ROOT, targetPath);
  const backupPath = path.join(backupDir, relative);
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  await fs.rename(targetPath, backupPath);
}

async function replacePath(sourcePath: string, targetPath: string, backupDir: string): Promise<void> {
  if (!await pathExists(sourcePath)) return;
  await backupPath(targetPath, backupDir);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.cp(sourcePath, targetPath, { recursive: true, force: true, dereference: false });
}

async function chmodRecursive(targetPath: string, dirMode: number, fileMode: number): Promise<void> {
  if (!await pathExists(targetPath)) return;
  const stats = await fs.lstat(targetPath);
  await fs.chmod(targetPath, stats.isDirectory() ? dirMode : fileMode).catch(() => undefined);
  if (!stats.isDirectory()) return;
  const entries = await fs.readdir(targetPath);
  await Promise.all(entries.map((entry) => chmodRecursive(path.join(targetPath, entry), dirMode, fileMode)));
}

function tableExists(db: InstanceType<typeof Database>, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

function columnExists(db: InstanceType<typeof Database>, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function readRows(dbPath: string, tableName: string): Record<string, unknown>[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (!tableExists(db, tableName)) return [];
    return db.prepare(`SELECT * FROM ${tableName}`).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function restoreRows(db: InstanceType<typeof Database>, tableName: string, rows: Record<string, unknown>[]): void {
  if (!tableExists(db, tableName)) return;
  db.prepare(`DELETE FROM ${tableName}`).run();
  if (rows.length === 0) return;

  for (const row of rows) {
    const keys = Object.keys(row);
    const columns = keys.map((key) => `"${key}"`).join(', ');
    const placeholders = keys.map((key) => `@${key}`).join(', ');
    db.prepare(`INSERT INTO ${tableName} (${columns}) VALUES (${placeholders})`).run(row);
  }
}

function deleteRowsIfTableExists(db: InstanceType<typeof Database>, tableName: string): void {
  if (tableExists(db, tableName)) {
    db.prepare(`DELETE FROM ${tableName}`).run();
  }
}

function quickCheck(db: InstanceType<typeof Database>): void {
  const row = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
  if (row?.quick_check !== 'ok') {
    throw new Error(`SQLite quick_check failed: ${row?.quick_check || 'unknown'}`);
  }
}

function isManagedVm(): boolean {
  const managedFlag = (process.env.CANVAS_MANAGED_SERVICES_ENABLED || '').toLowerCase();
  return Boolean(process.env.CANVAS_INSTANCE_TOKEN || managedFlag === 'true' || managedFlag === '1');
}

async function applyDatabase(params: {
  sourceDbPath: string;
  backupDir: string;
  preserveTargetInstanceAndLicense: boolean;
  invalidateSessions: boolean;
  pauseAutomations: boolean;
  clearOAuthTokens: boolean;
}): Promise<void> {
  const targetDbPath = path.join(DATA_ROOT, 'sqlite.db');
  const targetInstancePath = path.join(DATA_ROOT, 'instance-id');
  const preservedInstanceId = await fs.readFile(targetInstancePath, 'utf8').catch(() => null);
  const managedVm = isManagedVm();
  const licenseCertRows = params.preserveTargetInstanceAndLicense && managedVm
    ? readRows(targetDbPath, 'license_certs')
    : [];
  const licensePublicKeyRows = params.preserveTargetInstanceAndLicense && managedVm
    ? readRows(targetDbPath, 'license_public_keys')
    : [];

  await backupPath(targetDbPath, params.backupDir);
  await fs.rm(`${targetDbPath}-wal`, { force: true }).catch(() => undefined);
  await fs.rm(`${targetDbPath}-shm`, { force: true }).catch(() => undefined);
  await fs.copyFile(params.sourceDbPath, targetDbPath);
  await fs.chmod(targetDbPath, 0o600).catch(() => undefined);

  const db = new Database(targetDbPath);
  try {
    runMigrations(db);
    quickCheck(db);

    if (params.preserveTargetInstanceAndLicense) {
      restoreRows(db, 'license_certs', licenseCertRows);
      restoreRows(db, 'license_public_keys', licensePublicKeyRows);
    }

    if (params.invalidateSessions) {
      deleteRowsIfTableExists(db, 'session');
      deleteRowsIfTableExists(db, 'verification');
    }

    if (params.pauseAutomations && tableExists(db, 'automation_jobs')) {
      const assignments = ["status = 'paused'"];
      if (columnExists(db, 'automation_jobs', 'next_run_at')) {
        assignments.push('next_run_at = NULL');
      }
      if (columnExists(db, 'automation_jobs', 'updated_at')) {
        assignments.push('updated_at = ?');
        db.prepare(`UPDATE automation_jobs SET ${assignments.join(', ')} WHERE status != 'paused'`).run(Date.now());
      } else {
        db.prepare(`UPDATE automation_jobs SET ${assignments.join(', ')} WHERE status != 'paused'`).run();
      }
    }

    if (params.clearOAuthTokens) {
      deleteRowsIfTableExists(db, 'oauth_tokens');
    }

    quickCheck(db);
  } finally {
    db.close();
  }

  if (preservedInstanceId) {
    await fs.writeFile(targetInstancePath, preservedInstanceId, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(targetInstancePath, 0o600).catch(() => undefined);
  } else {
    await fs.rm(targetInstancePath, { force: true }).catch(() => undefined);
  }
}

async function clearOauthFiles(): Promise<void> {
  const targets = [
    path.join(DATA_ROOT, 'settings', 'auth.json'),
    path.join(DATA_ROOT, 'settings', 'mcp-oauth'),
    path.join(DATA_ROOT, 'canvas-agent', 'auth.json'),
    path.join(DATA_ROOT, 'canvas-agent', 'mcp-oauth'),
    path.join(DATA_ROOT, 'pi-oauth-states'),
    path.join(DATA_ROOT, 'secrets', 'email-oauth'),
  ];

  await Promise.all(targets.map((target) => fs.rm(target, { recursive: true, force: true }).catch(() => undefined)));
  await fs.mkdir(path.join(DATA_ROOT, 'pi-oauth-states'), { recursive: true }).catch(() => undefined);
}

async function applyFileComponents(params: {
  extractDataRoot: string;
  components: MigrationComponents;
  backupDir: string;
}): Promise<void> {
  for (const mapping of getSelectedMigrationComponentPaths(params.components)) {
    await replacePath(
      resolveMigrationDataPath(params.extractDataRoot, mapping),
      resolveMigrationDataPath(DATA_ROOT, mapping),
      params.backupDir,
    );
  }

  await chmodRecursive(path.join(DATA_ROOT, 'secrets'), 0o700, 0o600);
  await chmodRecursive(path.join(DATA_ROOT, 'settings'), 0o700, 0o600);
  await chmodRecursive(path.join(DATA_ROOT, 'canvas-agent'), 0o700, 0o600);
}

async function applyPendingRestore(pending: PendingMigrationRestore): Promise<void> {
  const manifest = await validateArchive(pending.archivePath);
  const restoreRoot = path.join(MIGRATION_ROOT, 'restores', pending.id);
  const extractRoot = path.join(restoreRoot, 'extract');
  const extractDataRoot = path.join(extractRoot, 'data');
  const backupDir = path.join(BACKUP_ROOT, new Date().toISOString().replace(/[:.]/g, '-'));

  await fs.rm(extractRoot, { recursive: true, force: true });
  await fs.mkdir(extractRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });

  log(`Extracting archive ${pending.archivePath}`);
  await execFileAsync('unzip', ['-q', pending.archivePath, '-d', extractRoot], { maxBuffer: 10 * 1024 * 1024 });
  await ensureNoSymlinks(extractRoot);

  await writeJsonPrivate(path.join(backupDir, 'restore-plan.json'), {
    pending,
    manifest: {
      exportId: manifest.exportId,
      appVersion: manifest.appVersion,
      components: manifest.components,
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
    },
  });

  log(`Backing up current data to ${backupDir}`);
  await applyFileComponents({
    extractDataRoot,
    components: pending.components,
    backupDir,
  });

  if (pending.components.database) {
    const sourceDbPath = path.join(extractDataRoot, 'sqlite.db');
    if (!await pathExists(sourceDbPath)) {
      throw new Error('Migration archive is missing data/sqlite.db.');
    }
    log('Applying SQLite snapshot and running migrations');
    await applyDatabase({
      sourceDbPath,
      backupDir,
      preserveTargetInstanceAndLicense: pending.preserveTargetInstanceAndLicense,
      invalidateSessions: pending.invalidateSessions,
      pauseAutomations: pending.pauseAutomations,
      clearOAuthTokens: pending.clearOAuthTokens,
    });
  }

  if (pending.clearOAuthTokens) {
    await clearOauthFiles();
  }

  await writeJsonPrivate(path.join(MIGRATION_ROOT, 'last-restore.json'), {
    id: pending.id,
    appliedAt: new Date().toISOString(),
    backupDir,
    exportId: manifest.exportId,
    exportAppVersion: manifest.appVersion,
    components: pending.components,
  });
}

async function main(): Promise<void> {
  if (!await pathExists(PENDING_RESTORE_PATH)) {
    log('No pending restore.');
    return;
  }

  const pending = await readJsonFile<PendingMigrationRestore>(PENDING_RESTORE_PATH);
  log(`Applying pending restore ${pending.id}`);

  try {
    await applyPendingRestore(pending);
    await fs.rm(PENDING_RESTORE_PATH, { force: true });
    log(`Restore ${pending.id} applied.`);
  } catch (error) {
    const failedPath = path.join(MIGRATION_ROOT, `failed-restore-${pending.id}.json`);
    await writeJsonPrivate(failedPath, {
      pending,
      failedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
    await fs.rm(PENDING_RESTORE_PATH, { force: true }).catch(() => undefined);
    throw error;
  }
}

main().catch((error) => {
  console.error('[migration-restore] Restore failed:', error);
  process.exit(1);
});
