import 'server-only';

import crypto from 'crypto';
import { execFile } from 'child_process';
import path from 'path';
import { createReadStream, createWriteStream, promises as fs, type WriteStream } from 'fs';
import { promisify } from 'util';
import Database from 'better-sqlite3';
import ZipStream from 'zip-stream';

import { getCurrentAppVersion } from '@/app/lib/migration/app-version';
import { getDatabaseProvider, getDeploymentMode } from '@/app/lib/organization/bootstrap';
import { resolveCanvasDataRoot, resolveSystemBackupsDir } from '@/app/lib/runtime-data-paths';
import {
  FULL_BACKUP_SCHEMA_VERSION,
  type CanvasFullBackupManifest,
  type FullBackupDatabaseManifest,
  type FullBackupFileEntry,
  type FullBackupInspection,
  type FullBackupJob,
  type FullBackupProvider,
  type FullBackupSource,
} from '@/app/lib/backups/types';

type ZipArchive = InstanceType<typeof ZipStream>;
type FullBackupSourceInput = Partial<Omit<FullBackupSource, 'databaseProvider'> & { databaseProvider: string | null }>;
interface FullBackupLock {
  backupId: string;
  createdAt: string;
  pid: number;
}

const execFileAsync = promisify(execFile);
const SQLITE_FILE_NAME = 'sqlite.db';
const BACKUP_STATUS_FILE = 'status.json';
const BACKUP_LOCK_FILE = '.full-backup.lock';
const BACKUP_WRITE_THROTTLE_MS = 750;
const activeFullBackups = new Map<string, Promise<void>>();

function normalizeProvider(value: string | null | undefined): FullBackupProvider {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'sqlite' || normalized === 'postgres') return normalized;
  return 'unknown';
}

function getBackupsRoot(): string {
  return resolveSystemBackupsDir();
}

function getBackupDir(backupId: string): string {
  return path.join(getBackupsRoot(), backupId);
}

function getBackupStatusPath(backupId: string): string {
  return path.join(getBackupDir(backupId), BACKUP_STATUS_FILE);
}

function getBackupLockPath(): string {
  return path.join(getBackupsRoot(), BACKUP_LOCK_FILE);
}

async function ensurePrivateDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fs.chmod(dirPath, 0o700).catch(() => undefined);
}

async function writeJsonPrivate(filePath: string, value: unknown): Promise<void> {
  await ensurePrivateDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

async function writeJobStatus(job: FullBackupJob): Promise<void> {
  await writeJsonPrivate(getBackupStatusPath(job.id), job);
}

async function readJobStatus(backupId: string): Promise<FullBackupJob | null> {
  if (!/^[a-f0-9-]{36}$/i.test(backupId)) return null;
  try {
    const raw = await fs.readFile(getBackupStatusPath(backupId), 'utf8');
    return JSON.parse(raw) as FullBackupJob;
  } catch {
    return null;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  return fs.stat(targetPath).then(() => true).catch(() => false);
}

function getErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

async function readBackupLock(lockPath: string): Promise<FullBackupLock | null> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, 'utf8');
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const lock = parsed as Partial<FullBackupLock>;
  if (!lock.backupId || !/^[a-f0-9-]{36}$/i.test(lock.backupId)) return null;
  if (!lock.createdAt || Number.isNaN(Date.parse(lock.createdAt))) return null;
  const pid = lock.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  return {
    backupId: lock.backupId,
    createdAt: lock.createdAt,
    pid,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return getErrorCode(error) !== 'ESRCH';
  }
}

async function markStaleLockedJobFailed(lock: FullBackupLock): Promise<void> {
  const job = await readJobStatus(lock.backupId);
  if (!job || (job.status !== 'queued' && job.status !== 'running')) return;
  job.status = 'failed';
  job.phase = 'Failed';
  job.error = `Backup lock from PID ${lock.pid} became stale after process exit.`;
  job.updatedAt = new Date().toISOString();
  await writeJobStatus(job).catch(() => undefined);
}

async function hasActiveBackupLock(): Promise<boolean> {
  const lockPath = getBackupLockPath();
  const lock = await readBackupLock(lockPath);
  if (!lock) {
    if (await pathExists(lockPath)) {
      await fs.unlink(lockPath).catch(() => undefined);
    }
    return false;
  }

  if (isProcessAlive(lock.pid)) return true;

  await markStaleLockedJobFailed(lock);
  await fs.unlink(lockPath).catch(() => undefined);
  return false;
}

async function acquireBackupLock(job: FullBackupJob): Promise<() => Promise<void>> {
  await ensurePrivateDir(getBackupsRoot());
  const lockPath = getBackupLockPath();
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (getErrorCode(error) === 'EEXIST') {
      throw new Error('Another full backup is already running.');
    }
    throw error;
  }

  try {
    await handle.writeFile(`${JSON.stringify({
      backupId: job.id,
      createdAt: new Date().toISOString(),
      pid: process.pid,
    }, null, 2)}\n`);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.unlink(lockPath).catch(() => undefined);
    throw error;
  }

  return async () => {
    await handle.close().catch(() => undefined);
    await fs.unlink(lockPath).catch(() => undefined);
  };
}

function shouldSkipDataPath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join('/');
  const parts = normalized.split('/').filter(Boolean);
  if (normalized === SQLITE_FILE_NAME) return true;
  if (parts.includes('node_modules') || parts.includes('.next') || parts.includes('.git')) return true;
  if (parts.includes('cache') || parts.includes('temp') || parts.includes('logs')) return true;
  if (parts[0] === 'system' && parts[1] === 'backups') return true;
  if (parts[0] === '.migration' || parts[0] === '.restore-backups') return true;
  return false;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function collectDataFiles(dataRoot: string): Promise<Array<FullBackupFileEntry & { filePath: string }>> {
  const entries: Array<FullBackupFileEntry & { filePath: string }> = [];

  async function walk(currentPath: string): Promise<void> {
    let dirents: import('fs').Dirent[];
    try {
      dirents = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }

    for (const dirent of dirents) {
      const absolutePath = path.join(currentPath, dirent.name);
      const relativePath = path.relative(dataRoot, absolutePath);
      if (shouldSkipDataPath(relativePath)) continue;
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!dirent.isFile()) continue;

      const stats = await fs.stat(absolutePath);
      entries.push({
        kind: 'data',
        filePath: absolutePath,
        archivePath: `data/${relativePath.split(path.sep).join('/')}`,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        sha256: await sha256File(absolutePath),
      });
    }
  }

  await walk(dataRoot);
  return entries.sort((a, b) => a.archivePath.localeCompare(b.archivePath));
}

async function createSqliteFullSnapshot(dataRoot: string, backupDir: string): Promise<{
  database: FullBackupDatabaseManifest;
  entry: FullBackupFileEntry & { filePath: string };
}> {
  const sourcePath = path.join(dataRoot, SQLITE_FILE_NAME);
  const snapshotPath = path.join(backupDir, 'database', SQLITE_FILE_NAME);
  await ensurePrivateDir(path.dirname(snapshotPath));

  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(snapshotPath);
  } finally {
    source.close();
  }

  const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
  try {
    const check = snapshot.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    if (check?.quick_check !== 'ok') {
      throw new Error(`SQLite backup quick_check failed: ${check?.quick_check || 'unknown'}`);
    }
  } finally {
    snapshot.close();
  }

  const stats = await fs.stat(snapshotPath);
  const sha256 = await sha256File(snapshotPath);
  return {
    database: {
      provider: 'sqlite',
      backupKind: 'sqlite_snapshot',
      artifactPath: 'database/sqlite.db',
      artifactSha256: sha256,
      postgresVersion: null,
      pgvectorEnabled: null,
      pgvectorVersion: null,
    },
    entry: {
      kind: 'database',
      filePath: snapshotPath,
      archivePath: 'database/sqlite.db',
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      sha256,
    },
  };
}

function parsePostgresUrl(raw: string): {
  host: string;
  port: string;
  user: string;
  password: string | null;
  database: string;
} {
  const url = new URL(raw);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use postgres:// or postgresql:// for Postgres backups.');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ''));
  if (!url.hostname || !url.username || !database) {
    throw new Error('DATABASE_URL is missing host, user, or database for Postgres backup.');
  }
  return {
    host: url.hostname,
    port: url.port || '5432',
    user: decodeURIComponent(url.username),
    password: url.password ? decodeURIComponent(url.password) : null,
    database,
  };
}

async function createPostgresDump(backupDir: string): Promise<{
  database: FullBackupDatabaseManifest;
  entry: FullBackupFileEntry & { filePath: string };
}> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('Postgres backup requires DATABASE_URL.');
  }

  const connection = parsePostgresUrl(databaseUrl);
  const dumpPath = path.join(backupDir, 'database', 'postgres.dump');
  await ensurePrivateDir(path.dirname(dumpPath));
  await execFileAsync('pg_dump', [
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    '--file',
    dumpPath,
    '--host',
    connection.host,
    '--port',
    connection.port,
    '--username',
    connection.user,
    connection.database,
  ], {
    env: {
      ...process.env,
      ...(connection.password ? { PGPASSWORD: connection.password } : {}),
    },
    maxBuffer: 1024 * 1024,
  });
  await fs.chmod(dumpPath, 0o600).catch(() => undefined);

  const version = await execFileAsync('pg_dump', ['--version'], { encoding: 'utf8' })
    .then(({ stdout }) => stdout.trim())
    .catch(() => null);
  const stats = await fs.stat(dumpPath);
  const sha256 = await sha256File(dumpPath);
  return {
    database: {
      provider: 'postgres',
      backupKind: 'postgres_dump',
      artifactPath: 'database/postgres.dump',
      artifactSha256: sha256,
      postgresVersion: version,
      pgvectorEnabled: process.env.CANVAS_POSTGRES_VECTOR_ENABLED === 'true',
      pgvectorVersion: process.env.CANVAS_POSTGRES_VECTOR_VERSION?.trim() || null,
    },
    entry: {
      kind: 'database',
      filePath: dumpPath,
      archivePath: 'database/postgres.dump',
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      sha256,
    },
  };
}

async function addZipEntry(
  archive: ZipArchive,
  source: NodeJS.ReadableStream | Buffer | string | null,
  data: { name: string; type?: 'file' | 'directory'; stats?: import('fs').Stats },
) {
  return new Promise<void>((resolve, reject) => {
    archive.entry(source, data, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function createCountingStream(filePath: string, onBytes: (bytes: number) => void) {
  const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  stream.on('data', (chunk) => onBytes(Buffer.byteLength(chunk)));
  return stream;
}

function manifestEntry(entry: FullBackupFileEntry & { filePath: string }): FullBackupFileEntry {
  return {
    kind: entry.kind,
    archivePath: entry.archivePath,
    size: entry.size,
    modifiedAt: entry.modifiedAt,
    sha256: entry.sha256,
  };
}

function buildSource(source?: FullBackupSourceInput): FullBackupSource {
  return {
    databaseProvider: normalizeProvider(source?.databaseProvider ?? getDatabaseProvider()),
    deploymentMode: source?.deploymentMode ?? getDeploymentMode(),
    teamFeaturesEnabled: source?.teamFeaturesEnabled ?? process.env.CANVAS_TEAM_FEATURES_ENABLED === 'true',
    managedServicesEnabled: source?.managedServicesEnabled ?? process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true',
    organizationId: source?.organizationId ?? (process.env.CANVAS_ORGANIZATION_ID?.trim() || null),
    createdByUserId: source?.createdByUserId ?? null,
    createdByEmail: source?.createdByEmail ?? null,
    createdByRole: source?.createdByRole ?? null,
  };
}

function buildManifest(params: {
  backupId: string;
  source: FullBackupSource;
  database: FullBackupDatabaseManifest;
  files: FullBackupFileEntry[];
}): CanvasFullBackupManifest {
  const warnings = [
    'Full backups are local V1 disaster-recovery artifacts and are not automatically encrypted.',
    'Raw local secret files, OAuth state, public-link tokens, and system runtime files may be included.',
    'Only Owner/Admin recovery flows should restore this archive.',
    'Restore must run through a preview or explicit disaster-recovery confirmation before writing data.',
  ];
  if (params.database.provider === 'postgres') {
    warnings.push('Postgres backups require pg_restore-compatible tooling and a prepared Postgres target.');
  }

  return {
    format: 'canvas-notebook-full-backup',
    backupSchemaVersion: FULL_BACKUP_SCHEMA_VERSION,
    appVersion: getCurrentAppVersion(),
    backupId: params.backupId,
    createdAt: new Date().toISOString(),
    source: params.source,
    database: params.database,
    security: {
      fullDisasterRecovery: true,
      publicLinksIncluded: true,
      publicLinkTokensIncluded: true,
      rawSecretsIncluded: true,
      unencryptedArchive: true,
      warning: 'Host/container admins can read local V1 backup artifacts and database dumps.',
    },
    restore: {
      requiresPostgres: params.database.provider === 'postgres',
      requiresReindex: false,
      preservesTargetInstanceAndLicense: false,
      publicLinksIncluded: true,
    },
    fileCount: params.files.length,
    totalBytes: params.files.reduce((sum, entry) => sum + entry.size, 0),
    warnings,
    files: params.files,
  };
}

async function runFullBackup(job: FullBackupJob, releaseLock: () => Promise<void>): Promise<void> {
  const dataRoot = resolveCanvasDataRoot();
  const backupDir = getBackupDir(job.id);
  const archivePath = path.join(backupDir, job.fileName);
  let lastStatusWrite = 0;
  let archive: ZipArchive | null = null;
  let output: WriteStream | null = null;
  let outputFinished: Promise<void> | null = null;

  const persist = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastStatusWrite < BACKUP_WRITE_THROTTLE_MS) return;
    lastStatusWrite = now;
    job.updatedAt = new Date().toISOString();
    await writeJobStatus(job);
  };

  try {
    await ensurePrivateDir(backupDir);

    job.status = 'running';
    job.phase = 'Creating database backup';
    await persist(true);

    const databaseArtifact = job.source.databaseProvider === 'postgres'
      ? await createPostgresDump(backupDir)
      : await createSqliteFullSnapshot(dataRoot, backupDir);

    job.phase = 'Scanning data files';
    await persist(true);
    const dataFiles = await collectDataFiles(dataRoot);
    const files = [databaseArtifact.entry, ...dataFiles];
    const manifestFiles = files.map(manifestEntry);
    const manifest = buildManifest({
      backupId: job.id,
      source: job.source,
      database: databaseArtifact.database,
      files: manifestFiles,
    });
    job.manifest = manifest;
    job.progress.fileCount = manifest.fileCount;
    job.progress.totalBytes = manifest.totalBytes;
    job.phase = 'Writing archive';
    await persist(true);

    const zipArchive = new ZipStream({ level: 1, forceZip64: true });
    const archiveOutput = createWriteStream(archivePath, { mode: 0o600 });
    archive = zipArchive;
    output = archiveOutput;
    zipArchive.pipe(archiveOutput);

    outputFinished = new Promise<void>((resolve, reject) => {
      archiveOutput.on('close', resolve);
      archiveOutput.on('error', reject);
      zipArchive.on('error', reject);
    });

    await addZipEntry(zipArchive, `${JSON.stringify(manifest, null, 2)}\n`, { name: 'manifest.json' });
    for (const entry of files) {
      const stats = await fs.stat(entry.filePath);
      const stream = createCountingStream(entry.filePath, (bytes) => {
        job.progress.bytesProcessed += bytes;
        void persist();
      });
      await addZipEntry(zipArchive, stream, { name: entry.archivePath, stats });
      job.progress.filesProcessed++;
      await persist();
    }

    zipArchive.finish();
    await outputFinished;
    await fs.chmod(archivePath, 0o600).catch(() => undefined);

    job.filePath = archivePath;
    job.archiveSha256 = await sha256File(archivePath);
    job.status = 'completed';
    job.phase = 'Completed';
    job.progress.bytesProcessed = job.progress.totalBytes;
    job.progress.filesProcessed = job.progress.fileCount;
    await persist(true);
  } catch (error) {
    archive?.destroy(error instanceof Error ? error : undefined);
    output?.destroy();
    await outputFinished?.catch(() => undefined);
    await fs.rm(archivePath, { force: true }).catch(() => undefined);
    delete job.filePath;
    delete job.archiveSha256;
    job.status = 'failed';
    job.phase = 'Failed';
    job.error = error instanceof Error ? error.message : 'Full backup failed';
    await writeJobStatus(job);
  } finally {
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'failed';
      job.phase = 'Failed';
      job.error = job.error || 'Full backup ended before completion.';
      await writeJobStatus(job).catch(() => undefined);
    }
    await releaseLock();
  }
}

export async function createFullBackupJob(options: { source?: FullBackupSourceInput } = {}): Promise<FullBackupJob> {
  if (activeFullBackups.size > 0 || await hasActiveBackupLock()) {
    throw new Error('Another full backup is already running.');
  }

  const id = crypto.randomUUID();
  const source = buildSource(options.source);
  const now = new Date().toISOString();
  const job: FullBackupJob = {
    id,
    status: 'queued',
    phase: 'Queued',
    createdAt: now,
    updatedAt: now,
    fileName: `canvas-full-backup-${getCurrentAppVersion()}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`,
    source,
    progress: {
      fileCount: 0,
      totalBytes: 0,
      filesProcessed: 0,
      bytesProcessed: 0,
    },
  };

  const releaseLock = await acquireBackupLock(job);
  try {
    await writeJobStatus(job);
  } catch (error) {
    await releaseLock();
    throw error;
  }
  const run = runFullBackup(job, releaseLock);
  activeFullBackups.set(id, run);
  void run.finally(() => activeFullBackups.delete(id));
  return job;
}

export async function getFullBackupJob(backupId: string): Promise<FullBackupJob | null> {
  return readJobStatus(backupId);
}

export async function listFullBackupJobs(): Promise<FullBackupJob[]> {
  await ensurePrivateDir(getBackupsRoot());
  const dirents = await fs.readdir(getBackupsRoot(), { withFileTypes: true }).catch(() => []);
  const jobs = await Promise.all(
    dirents
      .filter((dirent) => dirent.isDirectory() && /^[a-f0-9-]{36}$/i.test(dirent.name))
      .map((dirent) => readJobStatus(dirent.name)),
  );
  return jobs
    .filter((job): job is FullBackupJob => Boolean(job))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function unzipText(args: string[], maxBuffer = 100 * 1024 * 1024): Promise<string> {
  const { stdout } = await execFileAsync('unzip', args, { encoding: 'utf8', maxBuffer });
  return stdout;
}

function parseManifest(raw: string): CanvasFullBackupManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const manifest = parsed as Partial<CanvasFullBackupManifest>;
  if (manifest.format !== 'canvas-notebook-full-backup') return null;
  if (typeof manifest.backupSchemaVersion !== 'number') return null;
  if (typeof manifest.backupId !== 'string') return null;
  if (!manifest.source || !manifest.database || !manifest.security || !manifest.restore) return null;
  if (!Array.isArray(manifest.files)) return null;
  return manifest as CanvasFullBackupManifest;
}

export async function inspectFullBackupArchive(archivePath: string): Promise<FullBackupInspection> {
  const warnings: string[] = [];
  const risks: string[] = [];
  const targetProvider = normalizeProvider(getDatabaseProvider());
  let manifest: CanvasFullBackupManifest | null = null;

  try {
    manifest = parseManifest(await unzipText(['-p', archivePath, 'manifest.json']));
  } catch (error) {
    risks.push(`Backup manifest could not be read: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  if (!manifest) {
    return {
      backupId: null,
      archivePath,
      currentDatabaseProvider: targetProvider,
      sourceDatabaseProvider: null,
      canRestore: false,
      risks,
      warnings,
      manifest: null,
    };
  }

  const sourceProvider = normalizeProvider(manifest.database.provider);
  if (manifest.security.unencryptedArchive) {
    warnings.push('Backup archive is local and unencrypted. Treat it as sensitive infrastructure data.');
  }
  if (sourceProvider === 'postgres' && targetProvider !== 'postgres') {
    risks.push('Postgres full backup cannot be restored into a SQLite target.');
  }
  if (manifest.backupSchemaVersion > FULL_BACKUP_SCHEMA_VERSION) {
    risks.push('Backup schema version is newer than this application can restore.');
  }
  if (!manifest.database.artifactPath || !manifest.database.artifactSha256) {
    risks.push('Backup database artifact is missing or has no checksum.');
  }

  return {
    backupId: manifest.backupId,
    archivePath,
    currentDatabaseProvider: targetProvider,
    sourceDatabaseProvider: sourceProvider,
    canRestore: risks.length === 0,
    risks,
    warnings,
    manifest,
  };
}
