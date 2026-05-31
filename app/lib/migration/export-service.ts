import 'server-only';

import crypto from 'crypto';
import path from 'path';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import { PassThrough } from 'stream';
import Database from 'better-sqlite3';
import ZipStream from 'zip-stream';

import { getCurrentAppVersion } from '@/app/lib/migration/app-version';
import {
  DEFAULT_MIGRATION_COMPONENTS,
  MIGRATION_BUNDLE_SCHEMA_VERSION,
  MIGRATION_COMPONENT_KEYS,
  type CanvasMigrationManifest,
  type MigrationComponentKey,
  type MigrationComponents,
  type MigrationExportJob,
  type MigrationExportOptions,
  type MigrationFileEntry,
} from '@/app/lib/migration/types';
import {
  ensureMigrationDir,
  getMigrationDataRoot,
  getMigrationExportsRoot,
} from '@/app/lib/migration/paths';
import {
  getSelectedMigrationComponentPaths,
  resolveMigrationDataPath,
} from '@/app/lib/migration/component-paths';

const EXPORT_STATUS_FILE = 'status.json';
const SQLITE_FILE_NAME = 'sqlite.db';
const EXPORT_WRITE_THROTTLE_MS = 750;

type ZipArchive = InstanceType<typeof ZipStream>;

const activeExports = new Map<string, Promise<void>>();

function cloneComponents(components?: Partial<MigrationComponents>): MigrationComponents {
  const next = { ...DEFAULT_MIGRATION_COMPONENTS, ...components };
  if (!next.secrets) {
    next.secrets = false;
  }
  return next;
}

function getExportDir(exportId: string): string {
  return path.join(getMigrationExportsRoot(), exportId);
}

function getExportStatusPath(exportId: string): string {
  return path.join(getExportDir(exportId), EXPORT_STATUS_FILE);
}

async function writeJobStatus(job: MigrationExportJob): Promise<void> {
  const filePath = getExportStatusPath(job.id);
  await ensureMigrationDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(job, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

async function readJobStatus(exportId: string): Promise<MigrationExportJob | null> {
  try {
    const raw = await fs.readFile(getExportStatusPath(exportId), 'utf8');
    return JSON.parse(raw) as MigrationExportJob;
  } catch {
    return null;
  }
}

function shouldSkipPath(filePath: string): boolean {
  const parts = filePath.split(path.sep);
  return parts.includes('.migration') ||
    parts.includes('.restore-backups') ||
    parts.includes('cache') ||
    parts.includes('logs') ||
    parts.includes('temp') ||
    parts.includes('node_modules') ||
    parts.includes('.next') ||
    parts.includes('.git');
}

async function collectFiles(
  component: MigrationComponentKey,
  sourcePath: string,
  archiveRoot: string,
): Promise<MigrationFileEntry[]> {
  const entries: MigrationFileEntry[] = [];

  async function walk(currentPath: string, currentArchivePath: string): Promise<void> {
    let dirents: import('fs').Dirent[];
    try {
      dirents = await fs.readdir(currentPath, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }

    for (const dirent of dirents) {
      const absolutePath = path.join(currentPath, dirent.name);
      if (shouldSkipPath(absolutePath)) continue;

      const archivePath = `${currentArchivePath}/${dirent.name}`.split(path.sep).join('/');
      if (dirent.isSymbolicLink()) {
        continue;
      }

      if (dirent.isDirectory()) {
        await walk(absolutePath, archivePath);
        continue;
      }

      if (!dirent.isFile()) continue;

      const stats = await fs.stat(absolutePath);
      entries.push({
        component,
        archivePath,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      });
    }
  }

  await walk(sourcePath, archiveRoot);
  return entries;
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

async function createSqliteSnapshot(dataRoot: string, exportDir: string): Promise<{
  filePath: string;
  entry: MigrationFileEntry;
}> {
  const sourcePath = path.join(dataRoot, SQLITE_FILE_NAME);
  const snapshotPath = path.join(exportDir, 'snapshot', SQLITE_FILE_NAME);
  await fs.mkdir(path.dirname(snapshotPath), { recursive: true });

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
      throw new Error(`SQLite snapshot quick_check failed: ${check?.quick_check || 'unknown'}`);
    }
  } finally {
    snapshot.close();
  }

  const stats = await fs.stat(snapshotPath);
  return {
    filePath: snapshotPath,
    entry: {
      component: 'database',
      archivePath: `data/${SQLITE_FILE_NAME}`,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    },
  };
}

function buildManifest(params: {
  exportId: string;
  components: MigrationComponents;
  files: MigrationFileEntry[];
}): CanvasMigrationManifest {
  const warnings: string[] = [
    'Sessions are invalidated during restore.',
    'Automations are paused during restore and must be re-enabled after verification.',
    'OAuth-based integrations may require re-authentication on the target VM.',
    'Target VM license and instance identity are not overwritten during restore.',
  ];

  if (!params.components.workspace) {
    warnings.push('Workspace files were not included. Existing file references may point to missing files.');
  }
  if (!params.components.studioOutputs) {
    warnings.push('Studio outputs were not included. Studio history may contain missing generated media.');
  }
  if (!params.components.userUploads) {
    warnings.push('User uploads were not included. Attachment references may point to missing files.');
  }
  if (!params.components.secrets) {
    warnings.push('Secrets were not included. API keys and local integration credentials must be configured again.');
  }

  return {
    format: 'canvas-notebook-migration',
    bundleSchemaVersion: MIGRATION_BUNDLE_SCHEMA_VERSION,
    appVersion: getCurrentAppVersion(),
    exportedAt: new Date().toISOString(),
    exportId: params.exportId,
    components: params.components,
    fileCount: params.files.length,
    totalBytes: params.files.reduce((sum, entry) => sum + entry.size, 0),
    warnings,
    files: params.files,
  };
}

function createCountingStream(filePath: string, onBytes: (bytes: number) => void) {
  const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  stream.on('data', (chunk) => onBytes(Buffer.byteLength(chunk)));
  return stream;
}

async function runExport(job: MigrationExportJob): Promise<void> {
  const dataRoot = getMigrationDataRoot();
  const exportDir = getExportDir(job.id);
  const archivePath = path.join(exportDir, job.fileName);
  let lastStatusWrite = 0;

  const persist = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastStatusWrite < EXPORT_WRITE_THROTTLE_MS) return;
    lastStatusWrite = now;
    job.updatedAt = new Date().toISOString();
    await writeJobStatus(job);
  };

  try {
    job.status = 'running';
    job.phase = 'Preparing file list';
    await persist(true);

    await ensureMigrationDir(exportDir);
    const files: MigrationFileEntry[] = [];
    let sqliteSnapshot: { filePath: string; entry: MigrationFileEntry } | null = null;

    if (job.components.database) {
      job.phase = 'Creating SQLite backup';
      await persist(true);
      sqliteSnapshot = await createSqliteSnapshot(dataRoot, exportDir);
      files.push(sqliteSnapshot.entry);
    }

    const componentRoots = getSelectedMigrationComponentPaths(job.components).map((mapping) => ({
      component: mapping.component,
      sourcePath: resolveMigrationDataPath(dataRoot, mapping),
      archiveRoot: mapping.archiveRoot,
    }));

    for (const root of componentRoots) {
      job.phase = `Scanning ${root.component}`;
      await persist(true);
      files.push(...await collectFiles(root.component, root.sourcePath, root.archiveRoot));
    }

    const manifest = buildManifest({ exportId: job.id, components: job.components, files });
    job.manifest = manifest;
    job.progress.fileCount = manifest.fileCount;
    job.progress.totalBytes = manifest.totalBytes;
    job.phase = 'Writing archive';
    await persist(true);

    const archive = new ZipStream({ level: 1, forceZip64: true });
    const output = createWriteStream(archivePath, { mode: 0o600 });
    archive.pipe(output);

    const outputFinished = new Promise<void>((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
    });

    await addZipEntry(archive, `${JSON.stringify(manifest, null, 2)}\n`, {
      name: 'manifest.json',
    });

    const filePathByArchivePath = new Map<string, string>();
    if (sqliteSnapshot) {
      filePathByArchivePath.set(sqliteSnapshot.entry.archivePath, sqliteSnapshot.filePath);
    }

    for (const root of componentRoots) {
      for (const entry of files.filter((item) => item.component === root.component)) {
        const relative = path.posix.relative(root.archiveRoot, entry.archivePath);
        filePathByArchivePath.set(entry.archivePath, path.join(root.sourcePath, relative));
      }
    }

    for (const entry of files) {
      const sourcePath = filePathByArchivePath.get(entry.archivePath);
      if (!sourcePath) continue;
      const stats = await fs.stat(sourcePath);
      const stream = createCountingStream(sourcePath, (bytes) => {
        job.progress.bytesProcessed += bytes;
        void persist();
      });
      await addZipEntry(archive, stream, { name: entry.archivePath, stats });
      job.progress.filesProcessed++;
      await persist();
    }

    archive.finish();
    await outputFinished;
    await fs.chmod(archivePath, 0o600).catch(() => undefined);

    job.filePath = archivePath;
    job.status = 'completed';
    job.phase = 'Completed';
    job.progress.bytesProcessed = job.progress.totalBytes;
    job.progress.filesProcessed = job.progress.fileCount;
    await persist(true);
  } catch (error) {
    job.status = 'failed';
    job.phase = 'Failed';
    job.error = error instanceof Error ? error.message : 'Export failed';
    await writeJobStatus(job);
  }
}

export async function createMigrationExportJob(options: Partial<MigrationExportOptions>): Promise<MigrationExportJob> {
  const id = crypto.randomUUID();
  const components = cloneComponents(options.components);
  const now = new Date().toISOString();
  const job: MigrationExportJob = {
    id,
    status: 'queued',
    phase: 'Queued',
    components,
    createdAt: now,
    updatedAt: now,
    fileName: `canvas-migration-${getCurrentAppVersion()}-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`,
    progress: {
      fileCount: 0,
      totalBytes: 0,
      filesProcessed: 0,
      bytesProcessed: 0,
    },
  };

  await writeJobStatus(job);
  const run = runExport(job);
  activeExports.set(id, run);
  void run.finally(() => activeExports.delete(id));
  return job;
}

export async function getMigrationExportJob(exportId: string): Promise<MigrationExportJob | null> {
  if (!/^[a-f0-9-]{36}$/i.test(exportId)) return null;
  return readJobStatus(exportId);
}

export function normalizeMigrationComponents(input: unknown): MigrationComponents {
  const source = input && typeof input === 'object' ? input as Partial<Record<MigrationComponentKey, unknown>> : {};
  const components = { ...DEFAULT_MIGRATION_COMPONENTS };
  for (const key of MIGRATION_COMPONENT_KEYS) {
    if (typeof source[key] === 'boolean') {
      components[key] = source[key];
    }
  }
  return components;
}

export async function getMigrationArchiveSize(filePath: string): Promise<number> {
  const stats = await fs.stat(filePath);
  return stats.size;
}

export function createSha256Stream() {
  const hash = crypto.createHash('sha256');
  const stream = new PassThrough();
  stream.on('data', (chunk) => hash.update(chunk));
  return {
    stream,
    digest: () => hash.digest('hex'),
  };
}
