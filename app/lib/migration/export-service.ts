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
  MIGRATION_EXPORT_PROFILES,
  type CanvasMigrationManifest,
  type MigrationComponentKey,
  type MigrationComponents,
  type MigrationExportDatabase,
  type MigrationExportFeatures,
  type MigrationExportJob,
  type MigrationExportOptions,
  type MigrationExportProfile,
  type MigrationExportSecurity,
  type MigrationExportSelection,
  type MigrationExportSource,
  type MigrationFileEntry,
} from '@/app/lib/migration/types';
import {
  ensureMigrationDir,
  getMigrationDataRoot,
  getMigrationExportsRoot,
} from '@/app/lib/migration/paths';
import {
  getSelectedMigrationExportComponentPaths,
  resolveMigrationDataPath,
} from '@/app/lib/migration/component-paths';
import { getDatabaseProvider, getDeploymentMode } from '@/app/lib/organization/bootstrap';

const EXPORT_STATUS_FILE = 'status.json';
const SQLITE_FILE_NAME = 'sqlite.db';
const EXPORT_WRITE_THROTTLE_MS = 750;
const RECONNECT_MANIFEST_ARCHIVE_PATH = 'data/reconnect-manifest.json';

type ZipArchive = InstanceType<typeof ZipStream>;

const activeExports = new Map<string, Promise<void>>();

function cloneComponents(components?: Partial<MigrationComponents>): MigrationComponents {
  const next = { ...DEFAULT_MIGRATION_COMPONENTS, ...components };
  next.secrets = next.secrets === true;
  return next;
}

function normalizeMigrationExportProfile(value: unknown): MigrationExportProfile {
  return MIGRATION_EXPORT_PROFILES.includes(value as MigrationExportProfile)
    ? value as MigrationExportProfile
    : 'standard';
}

function buildExportSelection(params: {
  profile: MigrationExportProfile;
  includePersonalWorkspaces?: boolean;
}): MigrationExportSelection {
  return {
    includePersonalWorkspaces: params.profile === 'full_admin' && params.includePersonalWorkspaces === true,
    includePublicLinks: false,
    includeRawSecrets: false,
  };
}

function buildExportSource(source?: Partial<MigrationExportSource>): MigrationExportSource {
  return {
    databaseProvider: source?.databaseProvider ?? getDatabaseProvider(),
    deploymentMode: source?.deploymentMode ?? getDeploymentMode(),
    teamFeaturesEnabled: source?.teamFeaturesEnabled ?? process.env.CANVAS_TEAM_FEATURES_ENABLED === 'true',
    managedServicesEnabled: source?.managedServicesEnabled ?? process.env.CANVAS_MANAGED_SERVICES_ENABLED === 'true',
    organizationId: source?.organizationId ?? (process.env.CANVAS_ORGANIZATION_ID?.trim() || null),
    createdByUserId: source?.createdByUserId ?? null,
    createdByEmail: source?.createdByEmail ?? null,
    createdByRole: source?.createdByRole ?? null,
  };
}

function buildExportSecurity(components: MigrationComponents): MigrationExportSecurity {
  return {
    publicLinksIncluded: false,
    publicLinkTokensIncluded: false,
    rawSecretsIncluded: false,
    secretsMode: components.secrets ? 'reconnect_manifest' : 'excluded',
    unencryptedArchive: true,
  };
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

const ALLOWED_SANITIZE_TABLES = new Set([
  'public_file_shares',
  'session',
  'verification',
  'channel_link_tokens',
  'oauth_tokens',
  'todo_email_reply_events',
  'todo_email_reply_watchers',
  'composio_webhook_subscriptions',
  'automation_webhook_triggers',
  'account',
]);

function assertAllowedSanitizeTable(tableName: string): void {
  if (!ALLOWED_SANITIZE_TABLES.has(tableName)) {
    throw new Error(`Unexpected migration sanitize table: ${tableName}`);
  }
}

function quoteSqlIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unexpected SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function tableExists(sqlite: InstanceType<typeof Database>, tableName: string): boolean {
  assertAllowedSanitizeTable(tableName);
  const row = sqlite.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(tableName);
  return Boolean(row);
}

function tableColumns(sqlite: InstanceType<typeof Database>, tableName: string): Set<string> {
  assertAllowedSanitizeTable(tableName);
  return new Set(
    sqlite.prepare(`PRAGMA table_info(${quoteSqlIdentifier(tableName)})`).all()
      .map((column) => (column as { name: string }).name),
  );
}

function nullColumns(sqlite: InstanceType<typeof Database>, tableName: string, columns: string[]): void {
  assertAllowedSanitizeTable(tableName);
  if (!tableExists(sqlite, tableName)) return;
  const existing = tableColumns(sqlite, tableName);
  const assignments = columns
    .filter((column) => existing.has(column))
    .map((column) => `${quoteSqlIdentifier(column)} = NULL`);
  if (assignments.length === 0) return;
  sqlite.prepare(`UPDATE ${quoteSqlIdentifier(tableName)} SET ${assignments.join(', ')}`).run();
}

function sanitizeSqliteMigrationSnapshot(snapshotPath: string): void {
  const snapshot = new Database(snapshotPath);
  try {
    const transaction = snapshot.transaction(() => {
      if (tableExists(snapshot, 'public_file_shares')) {
        snapshot.prepare('DELETE FROM public_file_shares').run();
      }
      if (tableExists(snapshot, 'session')) {
        snapshot.prepare('DELETE FROM session').run();
      }
      if (tableExists(snapshot, 'verification')) {
        snapshot.prepare('DELETE FROM verification').run();
      }
      if (tableExists(snapshot, 'channel_link_tokens')) {
        snapshot.prepare('DELETE FROM channel_link_tokens').run();
      }
      if (tableExists(snapshot, 'oauth_tokens')) {
        snapshot.prepare('DELETE FROM oauth_tokens').run();
      }
      if (tableExists(snapshot, 'todo_email_reply_events')) {
        snapshot.prepare('DELETE FROM todo_email_reply_events').run();
      }
      if (tableExists(snapshot, 'todo_email_reply_watchers')) {
        snapshot.prepare('DELETE FROM todo_email_reply_watchers').run();
      }
      if (tableExists(snapshot, 'composio_webhook_subscriptions')) {
        const columns = tableColumns(snapshot, 'composio_webhook_subscriptions');
        const assignments: string[] = [];
        const values: unknown[] = [];
        if (columns.has('encrypted_secret')) {
          assignments.push('encrypted_secret = ?');
          values.push('redacted');
        }
        if (columns.has('secret_preview')) {
          assignments.push('secret_preview = ?');
          values.push('redacted');
        }
        if (columns.has('status')) {
          assignments.push('status = ?');
          values.push('paused');
        }
        if (assignments.length > 0) {
          snapshot.prepare(`UPDATE ${quoteSqlIdentifier('composio_webhook_subscriptions')} SET ${assignments.join(', ')}`).run(...values);
        }
      }
      if (tableExists(snapshot, 'automation_webhook_triggers')) {
        const columns = tableColumns(snapshot, 'automation_webhook_triggers');
        const assignments: string[] = [];
        const values: unknown[] = [];
        if (columns.has('status')) {
          assignments.push('status = ?');
          values.push('paused');
        }
        if (columns.has('secret_preview')) {
          assignments.push('secret_preview = ?');
          values.push('redacted');
        }
        if (columns.has('secret_hash')) {
          assignments.push('secret_hash = ?');
          values.push('redacted');
        }
        if (assignments.length > 0) {
          snapshot.prepare(`UPDATE ${quoteSqlIdentifier('automation_webhook_triggers')} SET ${assignments.join(', ')}`).run(...values);
        }
      }
      nullColumns(snapshot, 'account', [
        'access_token',
        'refresh_token',
        'id_token',
        'access_token_expires_at',
        'refresh_token_expires_at',
        'password',
      ]);
    });
    transaction();
    snapshot.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    snapshot.close();
  }
}

async function maybeStat(pathname: string): Promise<import('fs').Stats | null> {
  try {
    return await fs.stat(pathname);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
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

function extractEnvKeys(raw: string): string[] {
  const keys = new Set<string>();
  for (const line of raw.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line);
    if (match?.[1]) keys.add(match[1]);
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

async function readRedactedEnvKeys(filePath: string): Promise<string[]> {
  const raw = await fs.readFile(filePath, 'utf8').catch((error) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  });
  return raw ? extractEnvKeys(raw) : [];
}

async function buildReconnectManifest(params: {
  dataRoot: string;
  job: MigrationExportJob;
}): Promise<{ content: string; entry: MigrationFileEntry } | null> {
  if (!params.job.components.secrets) return null;

  const entries: Array<{
    kind: 'env_file' | 'oauth_store' | 'secret_directory';
    scope: 'legacy' | 'user' | 'organization' | 'system';
    path: string;
    secretNames?: string[];
    requiresReconnect: true;
  }> = [];

  const addEnvFile = async (scope: 'legacy' | 'system', relativePath: string) => {
    const filePath = path.join(params.dataRoot, ...relativePath.split('/'));
    const secretNames = await readRedactedEnvKeys(filePath);
    const stat = await maybeStat(filePath);
    if (secretNames.length === 0 && !stat) return;
    entries.push({ kind: 'env_file', scope, path: relativePath, secretNames, requiresReconnect: true });
  };

  const addDirectory = async (
    kind: 'oauth_store' | 'secret_directory',
    scope: 'legacy' | 'user' | 'organization' | 'system',
    relativePath: string,
  ) => {
    const stat = await maybeStat(path.join(params.dataRoot, ...relativePath.split('/')));
    if (!stat?.isDirectory()) return;
    entries.push({ kind, scope, path: relativePath, requiresReconnect: true });
  };

  await addEnvFile('legacy', 'secrets/Canvas-Integrations.env');
  await addEnvFile('legacy', 'secrets/Canvas-Agents.env');
  await addDirectory('oauth_store', 'legacy', 'settings/mcp-oauth');
  await addDirectory('oauth_store', 'legacy', 'canvas-agent/mcp-oauth');
  await addDirectory('oauth_store', 'legacy', 'pi-oauth-states');
  await addDirectory('oauth_store', 'legacy', 'secrets/email-oauth');
  await addDirectory('secret_directory', 'user', 'users');
  await addDirectory('secret_directory', 'organization', 'organizations');
  await addDirectory('secret_directory', 'system', 'system/secrets');

  const manifest = {
    format: 'canvas-notebook-reconnect-manifest',
    generatedAt: new Date().toISOString(),
    exportId: params.job.id,
    rawSecretsIncluded: false,
    note: 'Migration exports never include raw secrets or OAuth tokens. Reconnect these integrations on the target instance.',
    entries,
  };
  const content = `${JSON.stringify(manifest, null, 2)}\n`;

  return {
    content,
    entry: {
      component: 'secrets',
      archivePath: RECONNECT_MANIFEST_ARCHIVE_PATH,
      size: Buffer.byteLength(content),
      modifiedAt: new Date().toISOString(),
    },
  };
}

async function createSqliteSnapshot(dataRoot: string, exportDir: string): Promise<{
  filePath: string;
  entry: MigrationFileEntry;
  sha256: string;
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

  sanitizeSqliteMigrationSnapshot(snapshotPath);

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
  const sha256 = await sha256File(snapshotPath);
  return {
    filePath: snapshotPath,
    sha256,
    entry: {
      component: 'database',
      archivePath: `data/${SQLITE_FILE_NAME}`,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    },
  };
}

function normalizeDatabaseProvider(value: string | null | undefined): MigrationExportDatabase['provider'] {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'sqlite' || normalized === 'postgres') return normalized;
  return 'unknown';
}

function buildFeatures(source: MigrationExportSource): MigrationExportFeatures {
  const truthy = (value: string | undefined) => value === 'true' || value === '1' || value === 'yes';
  return {
    teamWorkspaceEnabled: source.teamFeaturesEnabled || truthy(process.env.CANVAS_TEAM_WORKSPACE_ENABLED),
    knowledgeEnabled: truthy(process.env.CANVAS_KNOWLEDGE_ENABLED) || truthy(process.env.CANVAS_TEAM_KNOWLEDGE_BASE_ENABLED),
    embeddingsEnabled: truthy(process.env.CANVAS_EMBEDDINGS_ENABLED) || truthy(process.env.CANVAS_POSTGRES_VECTOR_ENABLED),
    collaborationEnabled: truthy(process.env.CANVAS_COLLABORATION_ENABLED),
  };
}

function buildDatabaseManifest(params: {
  source: MigrationExportSource;
  sqliteSnapshot: { entry: MigrationFileEntry; sha256: string } | null;
}): MigrationExportDatabase {
  const provider = normalizeDatabaseProvider(params.source.databaseProvider);
  if (provider === 'sqlite' && params.sqliteSnapshot) {
    return {
      provider,
      logicalSchemaVersion: null,
      migrationVersion: MIGRATION_BUNDLE_SCHEMA_VERSION,
      backupKind: 'sqlite_snapshot',
      artifactPath: params.sqliteSnapshot.entry.archivePath,
      artifactSha256: params.sqliteSnapshot.sha256,
      pgvectorEnabled: null,
      pgvectorVersion: null,
      postgresVersion: null,
    };
  }

  return {
    provider,
    logicalSchemaVersion: null,
    migrationVersion: MIGRATION_BUNDLE_SCHEMA_VERSION,
    backupKind: 'none',
    artifactPath: null,
    artifactSha256: null,
    pgvectorEnabled: provider === 'postgres' ? process.env.CANVAS_POSTGRES_VECTOR_ENABLED === 'true' : null,
    pgvectorVersion: provider === 'postgres' ? process.env.CANVAS_POSTGRES_VECTOR_VERSION?.trim() || null : null,
    postgresVersion: provider === 'postgres' ? process.env.CANVAS_POSTGRES_VERSION?.trim() || null : null,
  };
}

function buildManifest(params: {
  exportId: string;
  profile: MigrationExportProfile;
  components: MigrationComponents;
  selection: MigrationExportSelection;
  source: MigrationExportSource;
  security: MigrationExportSecurity;
  database: MigrationExportDatabase;
  features: MigrationExportFeatures;
  files: MigrationFileEntry[];
}): CanvasMigrationManifest {
  const warnings: string[] = [
    'Sessions are invalidated during restore.',
    'Automations are paused during restore and must be re-enabled after verification.',
    'OAuth-based integrations may require re-authentication on the target VM.',
    'Target VM license and instance identity are not overwritten during restore.',
    'Migration exports do not include active public links or public-link tokens.',
    'This V1 migration archive is stored locally without automatic encryption.',
  ];

  if (params.profile === 'full_admin' && params.selection.includePersonalWorkspaces) {
    warnings.push('Full Admin export includes selected personal workspace directories. Handle with elevated privacy controls.');
  }
  if (!params.selection.includePersonalWorkspaces) {
    warnings.push('Personal workspace directories are excluded unless Full Admin export explicitly includes them.');
  }
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
  } else {
    warnings.push('Only a redacted reconnect manifest is included for secrets; raw secret files and OAuth tokens are excluded.');
  }
  if (params.database.provider === 'postgres' && params.components.database) {
    warnings.push('Postgres database contents are not embedded in normal migration exports. Use Full Backup for a Postgres dump.');
  }

  return {
    format: 'canvas-notebook-migration',
    bundleSchemaVersion: MIGRATION_BUNDLE_SCHEMA_VERSION,
    appVersion: getCurrentAppVersion(),
    exportedAt: new Date().toISOString(),
    exportId: params.exportId,
    exportProfile: params.profile,
    components: params.components,
    selection: params.selection,
    source: params.source,
    security: params.security,
    database: params.database,
    features: params.features,
    restore: {
      requiresPostgres: params.database.provider === 'postgres',
      requiresReindex: params.database.provider === 'postgres' || params.features.knowledgeEnabled || params.features.embeddingsEnabled,
      preservesTargetInstanceAndLicense: true,
      publicLinksIncluded: false,
    },
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
    let sqliteSnapshot: { filePath: string; entry: MigrationFileEntry; sha256: string } | null = null;

    if (job.components.database && job.source.databaseProvider === 'sqlite') {
      job.phase = 'Creating SQLite backup';
      await persist(true);
      sqliteSnapshot = await createSqliteSnapshot(dataRoot, exportDir);
      files.push(sqliteSnapshot.entry);
    } else if (job.components.database) {
      job.phase = 'Recording database provider metadata';
      await persist(true);
    }

    const componentRoots = getSelectedMigrationExportComponentPaths(job.components, {
      includePersonalWorkspaces: job.selection.includePersonalWorkspaces,
    }).map((mapping) => ({
      component: mapping.component,
      sourcePath: resolveMigrationDataPath(dataRoot, mapping),
      archiveRoot: mapping.archiveRoot,
    }));
    const virtualFileContents = new Map<string, string>();

    for (const root of componentRoots) {
      job.phase = `Scanning ${root.component}`;
      await persist(true);
      files.push(...await collectFiles(root.component, root.sourcePath, root.archiveRoot));
    }

    const reconnectManifest = await buildReconnectManifest({ dataRoot, job });
    if (reconnectManifest) {
      files.push(reconnectManifest.entry);
      virtualFileContents.set(reconnectManifest.entry.archivePath, reconnectManifest.content);
    }

    const manifest = buildManifest({
      exportId: job.id,
      profile: job.profile,
      components: job.components,
      selection: job.selection,
      source: job.source,
      security: buildExportSecurity(job.components),
      database: buildDatabaseManifest({ source: job.source, sqliteSnapshot }),
      features: buildFeatures(job.source),
      files,
    });
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
      const virtualContent = virtualFileContents.get(entry.archivePath);
      if (virtualContent) {
        await addZipEntry(archive, virtualContent, { name: entry.archivePath });
        job.progress.bytesProcessed += Buffer.byteLength(virtualContent);
        job.progress.filesProcessed++;
        await persist();
        continue;
      }
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
  const profile = normalizeMigrationExportProfile(options.profile);
  const selection = buildExportSelection({
    profile,
    includePersonalWorkspaces: options.includePersonalWorkspaces,
  });
  const source = buildExportSource(options.source);
  const now = new Date().toISOString();
  const job: MigrationExportJob = {
    id,
    status: 'queued',
    phase: 'Queued',
    profile,
    components,
    selection,
    source,
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

export function normalizeMigrationExportOptions(input: unknown): Pick<MigrationExportOptions, 'components' | 'profile' | 'includePersonalWorkspaces'> {
  const source = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const profile = normalizeMigrationExportProfile(source.profile);
  return {
    components: normalizeMigrationComponents(source.components),
    profile,
    includePersonalWorkspaces: profile === 'full_admin' && source.includePersonalWorkspaces === true,
  };
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
