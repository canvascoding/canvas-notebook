import 'server-only';

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { normalizeDataScopeId, resolveSystemMigrationDir } from '@/app/lib/runtime-data-paths';
import { resolveLegacyWorkspaceRoot } from './context';
import { workspaceAbsoluteRoot, type WorkspaceRecord } from './service';

const LEGACY_WORKSPACE_IMPORT_NAME = '_legacy-workspace-import';
const MARKER_VERSION = 1;
const HIDDEN_LEGACY_METADATA_FILES = new Set(['.gitkeep', '.keep']);

export type LegacyWorkspaceMigrationResult = {
  status: 'migrated' | 'skipped';
  reason?: 'already_migrated' | 'source_missing' | 'source_empty' | 'invalid_target';
  markerPath: string;
  sourceRoot: string;
  targetRoot: string;
  copiedEntries: string[];
  conflictedEntries: string[];
  conflictRootRelativePath: string | null;
};

type LegacyWorkspaceMigrationManifest = {
  schemaVersion: number;
  operation: 'legacy-workspace-to-personal-workspace';
  organizationId: string;
  userId: string;
  sourceRoot: string;
  targetRoot: string;
  targetRootRelativePath: string;
  importedAt: string;
  copiedEntries: string[];
  conflictedEntries: string[];
  conflictRootRelativePath: string | null;
};

function safeMarkerName(organizationId: string, userId: string): string {
  return `${normalizeDataScopeId(organizationId, 'organizationId')}--${normalizeDataScopeId(userId, 'userId')}.json`;
}

function markerPathFor(organizationId: string, userId: string): string {
  return path.join(resolveSystemMigrationDir(), 'legacy-workspace-imports', safeMarkerName(organizationId, userId));
}

function isDirectory(targetPath: string): boolean {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function meaningfulLegacyEntries(sourceRoot: string): string[] {
  return readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => !HIDDEN_LEGACY_METADATA_FILES.has(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function importTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, '-');
}

function workspaceRelativePath(...segments: string[]): string {
  return segments.join('/').replace(/\/+/gu, '/');
}

function writeManifest(markerPath: string, manifest: LegacyWorkspaceMigrationManifest): void {
  mkdirSync(path.dirname(markerPath), { recursive: true });
  const tempPath = `${markerPath}.tmp-${Date.now()}-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(tempPath, markerPath);
}

function readExistingManifest(markerPath: string): Pick<LegacyWorkspaceMigrationResult, 'copiedEntries' | 'conflictedEntries' | 'conflictRootRelativePath'> {
  try {
    const manifest = JSON.parse(readFileSync(markerPath, 'utf8')) as Partial<LegacyWorkspaceMigrationManifest>;
    return {
      copiedEntries: Array.isArray(manifest.copiedEntries) ? manifest.copiedEntries.filter((entry) => typeof entry === 'string') : [],
      conflictedEntries: Array.isArray(manifest.conflictedEntries) ? manifest.conflictedEntries.filter((entry) => typeof entry === 'string') : [],
      conflictRootRelativePath: typeof manifest.conflictRootRelativePath === 'string' ? manifest.conflictRootRelativePath : null,
    };
  } catch {
    return { copiedEntries: [], conflictedEntries: [], conflictRootRelativePath: null };
  }
}

export function migrateLegacyWorkspaceToPersonalWorkspace(params: {
  organizationId: string;
  userId: string;
  personalWorkspace: WorkspaceRecord;
}): LegacyWorkspaceMigrationResult {
  const sourceRoot = resolveLegacyWorkspaceRoot();
  const targetRoot = workspaceAbsoluteRoot(params.personalWorkspace.rootRelativePath);
  const markerPath = markerPathFor(params.organizationId, params.userId);

  if (existsSync(markerPath)) {
    const existing = readExistingManifest(markerPath);
    return {
      status: 'skipped',
      reason: 'already_migrated',
      markerPath,
      sourceRoot,
      targetRoot,
      ...existing,
    };
  }

  if (!isDirectory(sourceRoot)) {
    return {
      status: 'skipped',
      reason: 'source_missing',
      markerPath,
      sourceRoot,
      targetRoot,
      copiedEntries: [],
      conflictedEntries: [],
      conflictRootRelativePath: null,
    };
  }

  const sourceReal = path.resolve(sourceRoot);
  const targetReal = path.resolve(targetRoot);
  if (sourceReal === targetReal || targetReal.startsWith(`${sourceReal}${path.sep}`)) {
    return {
      status: 'skipped',
      reason: 'invalid_target',
      markerPath,
      sourceRoot,
      targetRoot,
      copiedEntries: [],
      conflictedEntries: [],
      conflictRootRelativePath: null,
    };
  }

  const entries = meaningfulLegacyEntries(sourceRoot);
  if (entries.length === 0) {
    return {
      status: 'skipped',
      reason: 'source_empty',
      markerPath,
      sourceRoot,
      targetRoot,
      copiedEntries: [],
      conflictedEntries: [],
      conflictRootRelativePath: null,
    };
  }

  mkdirSync(targetRoot, { recursive: true });
  const copiedEntries: string[] = [];
  const conflictedEntries: string[] = [];
  const conflictImportDirName = importTimestamp();
  const conflictRootRelativePath = workspaceRelativePath(LEGACY_WORKSPACE_IMPORT_NAME, conflictImportDirName);
  let conflictRootCreated = false;

  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry);
    const directTargetPath = path.join(targetRoot, entry);

    if (!existsSync(directTargetPath)) {
      cpSync(sourcePath, directTargetPath, {
        recursive: true,
        preserveTimestamps: true,
        errorOnExist: true,
        force: false,
      });
      copiedEntries.push(entry);
      continue;
    }

    if (!conflictRootCreated) {
      mkdirSync(path.join(targetRoot, conflictRootRelativePath), { recursive: true });
      conflictRootCreated = true;
    }

    cpSync(sourcePath, path.join(targetRoot, conflictRootRelativePath, entry), {
      recursive: true,
      preserveTimestamps: true,
      errorOnExist: true,
      force: false,
    });
    conflictedEntries.push(entry);
  }

  const manifest: LegacyWorkspaceMigrationManifest = {
    schemaVersion: MARKER_VERSION,
    operation: 'legacy-workspace-to-personal-workspace',
    organizationId: params.organizationId,
    userId: params.userId,
    sourceRoot,
    targetRoot,
    targetRootRelativePath: params.personalWorkspace.rootRelativePath,
    importedAt: new Date().toISOString(),
    copiedEntries,
    conflictedEntries,
    conflictRootRelativePath: conflictedEntries.length > 0 ? conflictRootRelativePath : null,
  };
  writeManifest(markerPath, manifest);

  return {
    status: 'migrated',
    markerPath,
    sourceRoot,
    targetRoot,
    copiedEntries,
    conflictedEntries,
    conflictRootRelativePath: manifest.conflictRootRelativePath,
  };
}
