import 'server-only';

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  createAtomicTempPath,
  normalizeDataScopeId,
  resolveDefaultAgentsEnvPath,
  resolveDefaultIntegrationsEnvPath,
  resolveScopedAgentsEnvPath,
  resolveScopedIntegrationsEnvPath,
  resolveSystemMigrationDir,
} from '@/app/lib/runtime-data-paths';

type EnvKind = 'integrations' | 'agents';

type EnvEntry = {
  key: string;
  value: string;
};

export type LegacySecretMigrationResult = {
  status: 'migrated' | 'skipped';
  reason?: 'already_migrated' | 'source_missing' | 'source_empty';
  markerPath: string;
  userId: string;
  migratedFiles: Array<{
    kind: EnvKind;
    sourcePath: string;
    targetPath: string;
    copiedKeys: string[];
    preservedKeys: string[];
  }>;
};

type LegacySecretMigrationManifest = {
  schemaVersion: 1;
  operation: 'legacy-secrets-to-user-scope';
  userId: string;
  importedAt: string;
  migratedFiles: LegacySecretMigrationResult['migratedFiles'];
};

const LEGACY_ENV_FILES: Array<{
  kind: EnvKind;
  legacyPath: () => string;
  scopedPath: (userId: string) => string;
}> = [
  {
    kind: 'integrations',
    legacyPath: resolveDefaultIntegrationsEnvPath,
    scopedPath: (userId) => resolveScopedIntegrationsEnvPath({ userId }),
  },
  {
    kind: 'agents',
    legacyPath: resolveDefaultAgentsEnvPath,
    scopedPath: (userId) => resolveScopedAgentsEnvPath({ userId }),
  },
];

function markerPathFor(userId: string): string {
  return path.join(
    resolveSystemMigrationDir(),
    'legacy-secret-imports',
    `${normalizeDataScopeId(userId, 'userId')}.json`,
  );
}

function parseEnvEntries(content: string): EnvEntry[] {
  const entries: EnvEntry[] = [];

  for (const rawLine of content.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const equalsIndex = normalized.indexOf('=');
    if (equalsIndex <= 0) continue;

    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue;

    let value = normalized.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    entries.push({ key, value });
  }

  return entries;
}

function formatEnvValue(value: string): string {
  if (!value) return '';
  if (/^[A-Za-z0-9_./:-]+$/u.test(value)) return value;
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

function serializeEnvEntries(entries: EnvEntry[]): string {
  if (entries.length === 0) return '';
  const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
  return `${sorted.map((entry) => `${entry.key}=${formatEnvValue(entry.value)}`).join('\n')}\n`;
}

function readEnvEntries(filePath: string): EnvEntry[] {
  if (!isFile(filePath)) return [];
  return parseEnvEntries(readFileSync(filePath, 'utf8'));
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function writeEnvEntries(filePath: string, entries: EnvEntry[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = createAtomicTempPath(filePath);
  writeFileSync(tempPath, serializeEnvEntries(entries), { encoding: 'utf8', mode: 0o600 });
  renameSync(tempPath, filePath);
}

function writeManifest(markerPath: string, manifest: LegacySecretMigrationManifest): void {
  mkdirSync(path.dirname(markerPath), { recursive: true });
  const tempPath = createAtomicTempPath(markerPath);
  writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tempPath, markerPath);
}

export function migrateLegacySecretsToUserScope(userId: string): LegacySecretMigrationResult {
  const markerPath = markerPathFor(userId);
  if (existsSync(markerPath)) {
    return {
      status: 'skipped',
      reason: 'already_migrated',
      markerPath,
      userId,
      migratedFiles: [],
    };
  }

  const migratedFiles: LegacySecretMigrationResult['migratedFiles'] = [];
  let sawLegacyFile = false;
  let sawLegacyEntries = false;

  for (const file of LEGACY_ENV_FILES) {
    const sourcePath = file.legacyPath();
    if (!isFile(sourcePath)) continue;

    sawLegacyFile = true;
    const legacyEntries = readEnvEntries(sourcePath);
    if (legacyEntries.length === 0) continue;

    sawLegacyEntries = true;
    const targetPath = file.scopedPath(userId);
    const targetEntries = readEnvEntries(targetPath);
    const byKey = new Map(targetEntries.map((entry) => [entry.key, entry]));
    const copiedKeys: string[] = [];
    const preservedKeys: string[] = [];

    for (const legacyEntry of legacyEntries) {
      if (byKey.has(legacyEntry.key)) {
        preservedKeys.push(legacyEntry.key);
        continue;
      }

      byKey.set(legacyEntry.key, legacyEntry);
      copiedKeys.push(legacyEntry.key);
    }

    if (copiedKeys.length > 0) {
      writeEnvEntries(targetPath, Array.from(byKey.values()));
    } else {
      mkdirSync(path.dirname(targetPath), { recursive: true });
    }

    migratedFiles.push({
      kind: file.kind,
      sourcePath,
      targetPath,
      copiedKeys,
      preservedKeys,
    });
  }

  if (!sawLegacyFile || !sawLegacyEntries) {
    return {
      status: 'skipped',
      reason: sawLegacyFile ? 'source_empty' : 'source_missing',
      markerPath,
      userId,
      migratedFiles: [],
    };
  }

  writeManifest(markerPath, {
    schemaVersion: 1,
    operation: 'legacy-secrets-to-user-scope',
    userId,
    importedAt: new Date().toISOString(),
    migratedFiles,
  });

  return {
    status: 'migrated',
    markerPath,
    userId,
    migratedFiles,
  };
}
