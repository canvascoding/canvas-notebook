import 'server-only';

import { getCurrentAppVersion } from '@/app/lib/migration/app-version';
import {
  MIGRATION_BUNDLE_SCHEMA_VERSION,
  MIGRATION_COMPONENT_KEYS,
  MIGRATION_EXPORT_PROFILES,
  type CanvasMigrationManifest,
  type MigrationComponentKey,
  type MigrationComponents,
  type MigrationExportDatabase,
  type MigrationExportFeatures,
  type MigrationExportProfile,
  type MigrationExportRestore,
  type MigrationExportSecurity,
  type MigrationExportSelection,
  type MigrationExportSource,
  type MigrationImportDryRun,
  type MigrationImportReconnectRequirement,
  type MigrationImportUserMapping,
  type MigrationImportWorkspaceMapping,
  type MigrationInspection,
} from '@/app/lib/migration/types';
import { formatVersionCompatibilityMessage } from '@/app/lib/migration/version';
import {
  getDeploymentMode,
} from '@/app/lib/organization/config';
import { getDatabaseProvider } from '@/app/lib/db/provider';
import { openDb } from '@/app/lib/db';
import { MigrationArchiveError, openMigrationArchive, readMigrationEntry } from './archive';
import { mapMigrationWorkspaces, parseMigrationWorkspaces } from './mappings';
import type { MigrationMappingChoices, MigrationWorkspaceDescriptor } from './types';
import { buildRestoreFilePlan } from './restore-plan';
import { getMigrationDataRoot } from './paths';
import { DATABASE_ARTIFACT } from './database-schema';
import { inspectPortableDatabase } from './database-inspect';
import { mapDatabaseUsers, mapDatabaseWorkspaces } from './database-mappings';

function hasUnsafeZipEntry(entryName: string): boolean {
  if (!entryName || entryName.includes('\0')) return true;
  if (entryName.startsWith('/') || entryName.startsWith('\\')) return true;
  const normalized = entryName.replace(/\\/g, '/');
  return normalized.split('/').some((part) => part === '..') ||
    (!normalized.startsWith('data/') && normalized !== 'manifest.json');
}

async function listArchiveEntries(archivePath: string): Promise<string[]> {
  return (await openMigrationArchive(archivePath)).map(entry => entry.path);
}

async function validatePostgresDatabaseArtifact(params: {
  manifest: CanvasMigrationManifest;
  entries: string[];
}): Promise<string[]> {
  const blockers: string[] = [];
  if (!params.manifest.components.database) {
    return blockers;
  }

  const sourceProvider = params.manifest.database?.provider ?? params.manifest.source?.databaseProvider;
  if (sourceProvider !== 'postgres') return blockers;
  const backupKind = params.manifest.database?.backupKind ?? 'none';
  if (backupKind !== 'postgres_rows') blockers.push('PostgreSQL migration requires a current portable row snapshot; metadata-only and SQL dump archives cannot be applied.');
  const artifactPath = params.manifest.database?.artifactPath;
  if (artifactPath !== DATABASE_ARTIFACT) blockers.push('Portable PostgreSQL artifact path is missing or unsupported.');
  if (artifactPath && !params.entries.includes(artifactPath)) blockers.push(`Migration archive is missing ${artifactPath}.`);

  return blockers;
}

function hasUnsupportedSQLiteSource(manifest: CanvasMigrationManifest | null, entries: string[]): boolean {
  if (entries.includes('data/sqlite.db')) return true;
  if (!manifest?.components.database) return false;
  return manifest.source?.databaseProvider === 'sqlite';
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

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function parseExportSource(value: unknown): MigrationExportSource | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const databaseProvider = optionalString(source.databaseProvider);
  const deploymentMode = optionalString(source.deploymentMode);
  const teamFeaturesEnabled = optionalBoolean(source.teamFeaturesEnabled);
  const managedServicesEnabled = optionalBoolean(source.managedServicesEnabled);
  if (!databaseProvider || !deploymentMode || teamFeaturesEnabled === null || managedServicesEnabled === null) {
    return undefined;
  }

  return {
    databaseProvider,
    deploymentMode,
    teamFeaturesEnabled,
    managedServicesEnabled,
    organizationId: optionalString(source.organizationId),
    createdByUserId: optionalString(source.createdByUserId),
    createdByEmail: optionalString(source.createdByEmail),
    createdByRole: optionalString(source.createdByRole),
  };
}

function parseExportSelection(value: unknown): MigrationExportSelection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const selection = value as Record<string, unknown>;
  if (typeof selection.includePersonalWorkspaces !== 'boolean') return undefined;
  return {
    includePersonalWorkspaces: selection.includePersonalWorkspaces,
    includePublicLinks: false,
    includeRawSecrets: false,
  };
}

function parseExportSecurity(value: unknown): MigrationExportSecurity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const security = value as Record<string, unknown>;
  const secretsMode = security.secretsMode === 'reconnect_manifest' ? 'reconnect_manifest' : 'excluded';
  return {
    publicLinksIncluded: false,
    publicLinkTokensIncluded: false,
    rawSecretsIncluded: false,
    secretsMode,
    unencryptedArchive: true,
  };
}

function parseExportDatabase(value: unknown): MigrationExportDatabase | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const database = value as Record<string, unknown>;
  const provider = database.provider === 'postgres' || database.provider === 'unknown'
    ? database.provider
    : 'unknown';
  const backupKind = database.backupKind === 'postgres_dump' || database.backupKind === 'postgres_rows' || database.backupKind === 'none'
    ? database.backupKind
    : 'none';
  return {
    provider,
    logicalSchemaVersion: typeof database.logicalSchemaVersion === 'number' ? database.logicalSchemaVersion : null,
    migrationVersion: typeof database.migrationVersion === 'number' ? database.migrationVersion : null,
    backupKind,
    artifactPath: optionalString(database.artifactPath),
    artifactSha256: optionalString(database.artifactSha256),
    compressedBytes: typeof database.compressedBytes === 'number' ? database.compressedBytes : null,
    pgvectorEnabled: typeof database.pgvectorEnabled === 'boolean' ? database.pgvectorEnabled : null,
    pgvectorVersion: optionalString(database.pgvectorVersion),
    postgresVersion: optionalString(database.postgresVersion),
  };
}

function parseExportFeatures(value: unknown): MigrationExportFeatures | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const features = value as Record<string, unknown>;
  return {
    teamWorkspaceEnabled: features.teamWorkspaceEnabled === true,
    knowledgeEnabled: features.knowledgeEnabled === true,
    embeddingsEnabled: features.embeddingsEnabled === true,
    collaborationEnabled: features.collaborationEnabled === true,
  };
}

function parseExportRestore(value: unknown): MigrationExportRestore | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const restore = value as Record<string, unknown>;
  return {
    requiresPostgres: restore.requiresPostgres === true,
    requiresReindex: restore.requiresReindex === true,
    preservesTargetInstanceAndLicense: true,
    publicLinksIncluded: false,
  };
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
  const exportProfile = MIGRATION_EXPORT_PROFILES.includes(record.exportProfile as MigrationExportProfile)
    ? record.exportProfile as MigrationExportProfile
    : undefined;

  return {
    format: 'canvas-notebook-migration',
    bundleSchemaVersion: record.bundleSchemaVersion,
    appVersion: record.appVersion,
    exportedAt: record.exportedAt,
    exportId: record.exportId,
    exportProfile,
    components,
    selection: parseExportSelection(record.selection),
    source: parseExportSource(record.source),
    security: parseExportSecurity(record.security),
    database: parseExportDatabase(record.database),
    features: parseExportFeatures(record.features),
    restore: parseExportRestore(record.restore),
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
    directories: Array.isArray(record.directories) ? record.directories.filter((v): v is string => typeof v === 'string') : [],
    workspaces: parseMigrationWorkspaces(record.workspaces),
    users: Array.isArray(record.users) ? record.users.filter((u): u is { id: string; email: string | null } => Boolean(u
      && typeof u === 'object' && typeof u.id === 'string' && (typeof u.email === 'string' || u.email === null))) : [],
  };
}

type LocalUser = {
  id: string;
  email: string | null;
};

type LocalWorkspace = MigrationWorkspaceDescriptor;

type LocalImportContext = {
  databaseProvider: string;
  deploymentMode: string;
  organizationId: string | null;
  teamFeaturesEnabled: boolean;
  users: LocalUser[];
  workspaces: LocalWorkspace[];
};

type ReconnectManifestEntry = {
  kind?: unknown;
  scope?: unknown;
  path?: unknown;
  secretNames?: unknown;
};

async function readLocalImportContext(warnings: string[]): Promise<LocalImportContext> {
  const fallback: LocalImportContext = {
    databaseProvider: getDatabaseProvider(),
    deploymentMode: getDeploymentMode(),
    organizationId: null,
    teamFeaturesEnabled: false,
    users: [],
    workspaces: [],
  };

  if (getDatabaseProvider() === 'postgres') {
    try {
      const database = await openDb();
      try {
        const organization = await database.get(`
          SELECT organization_id AS "organizationId", deployment_mode AS "deploymentMode", team_features_enabled AS "teamFeaturesEnabled"
          FROM canvas_organization_settings
          ORDER BY created_at ASC
          LIMIT 1
        `) as { organizationId: string; deploymentMode: string; teamFeaturesEnabled: number } | undefined;
        const users = await database.all(`
          SELECT id, email
          FROM "user"
          ORDER BY created_at ASC
        `) as LocalUser[];
        const workspaces = await database.all(`
          SELECT
            id,
            organization_id AS "organizationId",
            type,
            owner_user_id AS "ownerUserId",
            root_relative_path AS "rootRelativePath",
            display_name AS "displayName"
          FROM canvas_workspaces
          WHERE status = 'active'
          ORDER BY created_at ASC
        `) as LocalWorkspace[];
        return {
          databaseProvider: getDatabaseProvider(),
          deploymentMode: organization?.deploymentMode || getDeploymentMode(),
          organizationId: organization?.organizationId || null,
          teamFeaturesEnabled: organization ? organization.teamFeaturesEnabled === 1 : false,
          users,
          workspaces,
        };
      } finally {
        await database.close();
      }
    } catch (error) {
      warnings.push(`Target mapping context could not be read: ${error instanceof Error ? error.message : 'unknown error'}`);
      return fallback;
    }
  }

  warnings.push('Target mapping context is unavailable because PostgreSQL is not configured.');
  return fallback;
}

function parseReconnectManifest(raw: string | null): MigrationImportReconnectRequirement[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];

  return entries
    .filter((entry): entry is ReconnectManifestEntry => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    .map((entry) => {
      const kind = entry.kind === 'env_file' || entry.kind === 'oauth_store' || entry.kind === 'secret_directory'
        ? entry.kind
        : 'unknown';
      const scope = entry.scope === 'legacy' || entry.scope === 'user' || entry.scope === 'organization' || entry.scope === 'system'
        ? entry.scope
        : 'unknown';
      const secretNames = Array.isArray(entry.secretNames)
        ? entry.secretNames.filter((item): item is string => typeof item === 'string').sort((a, b) => a.localeCompare(b))
        : [];
      return {
        kind,
        scope,
        path: optionalString(entry.path) || 'unknown',
        secretNames,
        required: true,
        reason: 'Reconnect on the target before re-enabling integrations, agents, automations, or mailboxes that depend on these credentials.',
      };
    });
}

function sourceArchivePaths(manifest: CanvasMigrationManifest, entries: string[]): string[] {
  return [...new Set([
    ...manifest.files.map((file) => file.archivePath),
    ...entries.filter((entry) => entry.startsWith('data/')),
  ])].sort((a, b) => a.localeCompare(b));
}

function buildUserMappings(params: {
  manifest: CanvasMigrationManifest;
  archivePaths: string[];
  target: LocalImportContext;
  choices?: MigrationMappingChoices;
}): MigrationImportUserMapping[] {
  type UserCandidate = { userId: string | null; email: string | null; required: boolean; reason: string };
  const candidates = new Map<string, UserCandidate>();
  const candidateKey = (input: Pick<UserCandidate, 'userId' | 'email'>) => {
    if (input.userId) return `id:${input.userId}`;
    if (input.email) return `email:${input.email.toLowerCase()}`;
    return null;
  };
  const findExistingCandidateKey = (input: Pick<UserCandidate, 'userId' | 'email'>) => {
    for (const [key, candidate] of candidates.entries()) {
      if (input.userId && candidate.userId === input.userId) return key;
      if (input.email && candidate.email?.toLowerCase() === input.email.toLowerCase()) return key;
    }
    return null;
  };
  const addCandidate = (input: { userId: string | null; email: string | null; required: boolean; reason: string }) => {
    if (!input.userId && !input.email) return;
    const existingKey = findExistingCandidateKey(input);
    const existing = existingKey ? candidates.get(existingKey) : null;
    if (existing) {
      existing.userId ||= input.userId;
      existing.email ||= input.email;
      existing.required ||= input.required;
      if (!existing.reason.includes(input.reason)) {
        existing.reason = `${existing.reason} ${input.reason}`;
      }
      return;
    }
    const key = candidateKey(input);
    if (!key) return;
    candidates.set(key, input);
  };

  addCandidate({
    userId: params.manifest.source?.createdByUserId ?? null,
    email: params.manifest.source?.createdByEmail ?? null,
    required: params.manifest.components.database,
    reason: 'Export creator and actor references from the source bundle.',
  });

  for (const archivePath of params.archivePaths) {
    const personalMatch = /^data\/workspaces\/personal\/([^/]+)(?:\/|$)/u.exec(archivePath);
    if (!personalMatch?.[1]) continue;
    addCandidate({
      userId: personalMatch[1],
      email: params.manifest.users?.find(user => user.id === personalMatch[1])?.email ?? null,
      required: true,
      reason: 'Personal workspace files require an explicit target user mapping.',
    });
  }

  for (const workspace of params.manifest.workspaces ?? []) {
    if (workspace.type !== 'personal' || !workspace.ownerUserId) continue;
    addCandidate({ userId: workspace.ownerUserId,
      email: params.manifest.users?.find(user => user.id === workspace.ownerUserId)?.email ?? null,
      required: true, reason: 'Personal workspace ownership must map to an existing target user.' });
  }

  return [...candidates.values()].map((candidate) => {
    const chosenId = candidate.userId ? params.choices?.users[candidate.userId] : undefined;
    if (chosenId) {
      const chosen = params.target.users.find(user => user.id === chosenId);
      if (!chosen) throw new Error('The selected target user is unavailable.');
      return { sourceUserId: candidate.userId, sourceEmail: candidate.email, targetUserId: chosen.id,
        targetEmail: chosen.email, status: 'mapped' as const, required: candidate.required,
        reason: 'Target user explicitly selected by the administrator for file ownership mapping.' };
    }
    const byId = candidate.userId ? params.target.users.find((user) => user.id === candidate.userId) : null;
    const byEmail = !byId && candidate.email
      ? params.target.users.find((user) => user.email?.toLowerCase() === candidate.email?.toLowerCase())
      : null;
    if (byId) {
      return {
        sourceUserId: candidate.userId,
        sourceEmail: candidate.email,
        targetUserId: byId.id,
        targetEmail: byId.email,
        status: 'mapped',
        required: candidate.required,
        reason: candidate.reason,
      };
    }
    if (byEmail) {
      return {
        sourceUserId: candidate.userId,
        sourceEmail: candidate.email,
        targetUserId: byEmail.id,
        targetEmail: byEmail.email,
        status: 'proposed',
        required: candidate.required,
        reason: `${candidate.reason} Email matched, but the current restore engine cannot rewrite user IDs yet.`,
      };
    }
    return {
      sourceUserId: candidate.userId,
      sourceEmail: candidate.email,
      targetUserId: null,
      targetEmail: null,
      status: candidate.required ? 'unresolved' : 'not_required',
      required: candidate.required,
      reason: candidate.reason,
    };
  });
}

function buildWorkspaceMappings(params: {
  manifest: CanvasMigrationManifest;
  archivePaths: string[];
  target: LocalImportContext;
  users: MigrationImportUserMapping[];
  choices?: MigrationMappingChoices;
}): MigrationImportWorkspaceMapping[] {
  return mapMigrationWorkspaces({ ...params, targets: params.target.workspaces });
}

async function buildDryRun(params: {
  manifest: CanvasMigrationManifest;
  entries: string[];
  reconnect: MigrationImportReconnectRequirement[];
  warnings: string[];
  choices?: MigrationMappingChoices;
}): Promise<MigrationImportDryRun> {
  const target = await readLocalImportContext(params.warnings);
  const archivePaths = sourceArchivePaths(params.manifest, params.entries);
  const databaseSnapshot = params.manifest.components.database && params.manifest.database?.backupKind === 'postgres_rows';
  const users = databaseSnapshot ? mapDatabaseUsers(params.manifest.users ?? [], target.users)
    : buildUserMappings({ manifest: params.manifest, archivePaths, target, choices: params.choices });
  const workspaces = databaseSnapshot ? mapDatabaseWorkspaces(params.manifest, archivePaths, users)
    : buildWorkspaceMappings({ manifest: params.manifest, archivePaths, target, users, choices: params.choices });
  const blockers: string[] = [];

  if (params.manifest.components.database) {
    const sourceProvider = params.manifest.database?.provider ?? params.manifest.source?.databaseProvider;
    if (sourceProvider === 'postgres') {
      if (target.databaseProvider !== 'postgres') {
        blockers.push('This export requires a Postgres target before database restore can be staged.');
      }
      if (!databaseSnapshot) blockers.push('Postgres database restore requires a current portable row snapshot.');
      if (params.manifest.source?.organizationId !== target.organizationId) blockers.push('Source and target database organizations must match; target license and Team Seat identity are preserved.');
    } else {
      blockers.push(`Source database provider ${sourceProvider ?? 'unknown'} is not supported by the PostgreSQL-only restore engine.`);
    }
  }

  if (
    params.manifest.restore?.requiresPostgres &&
    !params.manifest.components.database &&
    target.databaseProvider !== 'postgres'
  ) {
    blockers.push('Manifest restore metadata requires Postgres on the target instance.');
  }
  if (
    target.databaseProvider !== 'postgres' &&
    (params.manifest.features?.knowledgeEnabled || params.manifest.features?.embeddingsEnabled || params.manifest.features?.collaborationEnabled)
  ) {
    blockers.push('Knowledge, embeddings, or collaboration metadata requires a Postgres target and reindex before restore.');
  }

  for (const mapping of users) {
    if (mapping.required && mapping.status !== 'mapped') {
      const label = mapping.sourceEmail || mapping.sourceUserId || 'unknown user';
      blockers.push(mapping.status === 'proposed'
        ? `Select an explicit user mapping: ${label}.`
        : `User mapping unresolved: ${label}.`);
    }
  }
  for (const mapping of workspaces) {
    if (mapping.required && mapping.status !== 'mapped') {
      blockers.push(mapping.status === 'proposed'
        ? `Select an explicit workspace mapping: ${mapping.sourcePath}.`
        : `Workspace mapping unresolved: ${mapping.sourcePath}.`);
    }
  }

  const canApply = blockers.length === 0;
  const status = !canApply ? 'blocked' : params.reconnect.length > 0 ? 'attention_required' : 'ready';
  return {
    status,
    canApply,
    blockers,
    source: {
      exportProfile: params.manifest.exportProfile ?? null,
      databaseProvider: params.manifest.source?.databaseProvider ?? null,
      deploymentMode: params.manifest.source?.deploymentMode ?? null,
      organizationId: params.manifest.source?.organizationId ?? null,
      createdByUserId: params.manifest.source?.createdByUserId ?? null,
      createdByEmail: params.manifest.source?.createdByEmail ?? null,
    },
    target: {
      databaseProvider: target.databaseProvider,
      deploymentMode: target.deploymentMode,
      organizationId: target.organizationId,
      teamFeaturesEnabled: target.teamFeaturesEnabled,
    },
    users,
    workspaces,
    availableWorkspaces: target.workspaces,
    availableUsers: target.users,
    reconnect: params.reconnect,
    stats: {
      userMappings: users.length,
      workspaceMappings: workspaces.length,
      reconnectRequirements: params.reconnect.length,
      blockers: blockers.length,
    },
  };
}

function buildRisks(manifest: CanvasMigrationManifest | null): string[] {
  if (!manifest) {
    return ['This archive cannot be restored because it does not contain a valid migration manifest.'];
  }

  const risks = [
    'Selected files are written to approved target paths; matching files are replaced.',
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
  if (manifest.components.database) {
    risks.push('Application database tables are replaced. Target organization, Team Seat and license records are retained. Existing accounts with the same email must have matching IDs; use file migration mapping to reassign data between different accounts.');
  }
  if (manifest.restore?.requiresReindex) {
    risks.push('Knowledge or embedding indexes require reindexing after restore.');
  }

  return risks;
}

export async function inspectMigrationArchive(params: {
  uploadId: string;
  archivePath: string;
  mappings?: MigrationMappingChoices;
}): Promise<MigrationInspection> {
  let entries: string[];
  try { entries = await listArchiveEntries(params.archivePath); }
  catch (error) {
    if (!(error instanceof MigrationArchiveError)) throw error;
    return { uploadId: params.uploadId, archivePath: params.archivePath, currentAppVersion: getCurrentAppVersion(),
      exportAppVersion: null, compatibility: 'unsupported_bundle_schema', canRestore: false, manifest: null,
      warnings: [error.message], risks: ['The archive was rejected before restore.'] };
  }
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
    const manifestEntry = (await openMigrationArchive(params.archivePath)).find(entry => entry.path === 'manifest.json');
    if (!manifestEntry) throw new Error('Missing migration manifest.');
    const rawManifest = await readMigrationEntry(manifestEntry);
    manifest = parseManifest(rawManifest);
  } catch {
    manifest = null;
  }

  const currentAppVersion = getCurrentAppVersion();
  const bundleSchemaSupported = Boolean(manifest && manifest.bundleSchemaVersion >= 1 && manifest.bundleSchemaVersion <= MIGRATION_BUNDLE_SCHEMA_VERSION);
  const compatibility = formatVersionCompatibilityMessage({
    exportVersion: manifest?.appVersion ?? null,
    currentVersion: currentAppVersion,
    bundleSchemaSupported,
  });

  const warnings = [
    compatibility.message,
    ...(manifest?.warnings ?? []),
  ];
  const unsupportedSQLiteSource = hasUnsupportedSQLiteSource(manifest, entries);
  if (unsupportedSQLiteSource) {
    warnings.push('SQLite migration archives are no longer supported by the migration inspector; export a PostgreSQL migration archive.');
  }
  let reconnect: MigrationImportReconnectRequirement[] = [];
  if (!unsupportedSQLiteSource && (manifest?.components.secrets || manifest?.security?.secretsMode === 'reconnect_manifest')) {
    const reconnectEntry = (await openMigrationArchive(params.archivePath)).find(entry => entry.path === 'data/reconnect-manifest.json');
    const rawReconnect = reconnectEntry ? await readMigrationEntry(reconnectEntry).catch(() => null) : null;
    reconnect = parseReconnectManifest(rawReconnect);
    if (manifest.components.secrets && reconnect.length === 0) {
      warnings.push('Secrets were selected in the source export, but no reconnect manifest was found.');
    }
  }
  const dryRun = manifest && !unsupportedSQLiteSource
    ? await buildDryRun({ manifest, entries, reconnect, warnings, choices: params.mappings })
    : undefined;

  if (dryRun && manifest) {
    const databaseBlockers = await validatePostgresDatabaseArtifact({
      manifest,
      entries,
    });
    if (manifest.components.database && !databaseBlockers.length) {
      try {
        const entry = (await openMigrationArchive(params.archivePath)).find(file => file.path === DATABASE_ARTIFACT);
        if (!entry) throw new Error('Missing portable database snapshot.');
        await inspectPortableDatabase(entry, manifest);
      } catch (error) { databaseBlockers.push(error instanceof Error ? error.message : 'Invalid portable database snapshot.'); }
    }
    if (databaseBlockers.length > 0) {
      dryRun.blockers.push(...databaseBlockers);
      dryRun.canApply = false;
      dryRun.status = 'blocked';
      dryRun.stats.blockers = dryRun.blockers.length;
    }
    if (dryRun.canApply) {
      try {
        buildRestoreFilePlan({ dataRoot: getMigrationDataRoot(), manifest,
          entries: await openMigrationArchive(params.archivePath), mappings: dryRun.workspaces });
      } catch (error) {
        dryRun.blockers.push(error instanceof Error ? error.message : 'Invalid migration file plan.');
        dryRun.canApply = false; dryRun.status = 'blocked'; dryRun.stats.blockers = dryRun.blockers.length;
      }
    }
  }

  if (dryRun && !dryRun.canApply) {
    warnings.push('Import dry run is blocked. Resolve required blockers before staging restore.');
  } else if (dryRun?.reconnect.length) {
    warnings.push('Import dry run passed, but integrations listed in the reconnect manifest must be reconnected after restore.');
  }

  return {
    uploadId: params.uploadId,
    archivePath: params.archivePath,
    currentAppVersion,
    exportAppVersion: manifest?.appVersion ?? null,
    compatibility: compatibility.compatibility,
    canRestore: compatibility.canRestore && (dryRun?.canApply ?? false),
    manifest,
    dryRun,
    warnings,
    risks: buildRisks(manifest),
  };
}
