import 'server-only';

import { execFile } from 'child_process';
import { promisify } from 'util';

import { getCurrentAppVersion } from '@/app/lib/migration/app-version';
import {
  MIGRATION_BUNDLE_SCHEMA_VERSION,
  MIGRATION_COMPONENT_KEYS,
  type CanvasMigrationManifest,
  type MigrationComponentKey,
  type MigrationComponents,
  type MigrationInspection,
} from '@/app/lib/migration/types';
import { formatVersionCompatibilityMessage } from '@/app/lib/migration/version';

const execFileAsync = promisify(execFile);

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

async function listArchiveEntries(archivePath: string): Promise<string[]> {
  const output = await unzipText(['-Z1', archivePath]);
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

function parseComponents(value: unknown): MigrationComponents | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const components = {} as MigrationComponents;
  for (const key of MIGRATION_COMPONENT_KEYS) {
    if (typeof source[key] !== 'boolean') return null;
    components[key] = source[key] as boolean;
  }
  return components;
}

function parseManifest(raw: string): CanvasMigrationManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const components = parseComponents(record.components);
  if (!components) return null;
  if (record.format !== 'canvas-notebook-migration') return null;
  if (typeof record.bundleSchemaVersion !== 'number') return null;
  if (typeof record.appVersion !== 'string') return null;
  if (typeof record.exportedAt !== 'string') return null;
  if (typeof record.exportId !== 'string') return null;
  if (typeof record.fileCount !== 'number') return null;
  if (typeof record.totalBytes !== 'number') return null;

  return {
    format: 'canvas-notebook-migration',
    bundleSchemaVersion: record.bundleSchemaVersion,
    appVersion: record.appVersion,
    exportedAt: record.exportedAt,
    exportId: record.exportId,
    components,
    fileCount: record.fileCount,
    totalBytes: record.totalBytes,
    warnings: Array.isArray(record.warnings) ? record.warnings.filter((item): item is string => typeof item === 'string') : [],
    files: Array.isArray(record.files)
      ? record.files.filter((item): item is CanvasMigrationManifest['files'][number] => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        const file = item as Record<string, unknown>;
        return MIGRATION_COMPONENT_KEYS.includes(file.component as MigrationComponentKey) &&
          typeof file.archivePath === 'string' &&
          typeof file.size === 'number' &&
          typeof file.modifiedAt === 'string';
      })
      : [],
  };
}

function buildRisks(manifest: CanvasMigrationManifest | null): string[] {
  if (!manifest) {
    return ['This archive cannot be restored because it does not contain a valid migration manifest.'];
  }

  const risks = [
    'Full restore replaces selected data areas on the target VM.',
    'All active sessions are invalidated; users must log in again.',
    'Automations are paused during restore and must be reviewed before reactivation.',
    'OAuth-based integrations are cleared where possible and may need re-authentication.',
    'The target VM license and instance identity are preserved and not overwritten.',
  ];

  if (manifest.components.database && !manifest.components.workspace) {
    risks.push('The database is included without workspace files. Chats, automations, or records may reference missing workspace files.');
  }
  if (manifest.components.database && !manifest.components.studioOutputs) {
    risks.push('The database is included without Studio outputs. Studio history may reference missing generated media.');
  }
  if (manifest.components.database && !manifest.components.userUploads) {
    risks.push('The database is included without user uploads. Attachment references may be missing.');
  }
  if (!manifest.components.secrets) {
    risks.push('Secrets are not included. API keys and local integration credentials must be configured again.');
  }

  return risks;
}

export async function inspectMigrationArchive(params: {
  uploadId: string;
  archivePath: string;
}): Promise<MigrationInspection> {
  const entries = await listArchiveEntries(params.archivePath);
  const unsafeEntry = entries.find(hasUnsafeZipEntry);
  if (unsafeEntry) {
    return {
      uploadId: params.uploadId,
      archivePath: params.archivePath,
      currentAppVersion: getCurrentAppVersion(),
      exportAppVersion: null,
      compatibility: 'unsupported_bundle_schema',
      canRestore: false,
      manifest: null,
      warnings: [`Archive contains an unsafe path: ${unsafeEntry}`],
      risks: ['The archive was rejected before restore.'],
    };
  }

  let manifest: CanvasMigrationManifest | null = null;
  try {
    const rawManifest = await unzipText(['-p', params.archivePath, 'manifest.json'], 20 * 1024 * 1024);
    manifest = parseManifest(rawManifest);
  } catch {
    manifest = null;
  }

  const currentAppVersion = getCurrentAppVersion();
  const bundleSchemaSupported = manifest?.bundleSchemaVersion === MIGRATION_BUNDLE_SCHEMA_VERSION;
  const compatibility = formatVersionCompatibilityMessage({
    exportVersion: manifest?.appVersion ?? null,
    currentVersion: currentAppVersion,
    bundleSchemaSupported,
  });

  const warnings = [
    compatibility.message,
    ...(manifest?.warnings ?? []),
  ];

  return {
    uploadId: params.uploadId,
    archivePath: params.archivePath,
    currentAppVersion,
    exportAppVersion: manifest?.appVersion ?? null,
    compatibility: compatibility.compatibility,
    canRestore: compatibility.canRestore,
    manifest,
    warnings,
    risks: buildRisks(manifest),
  };
}
