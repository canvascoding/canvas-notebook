import 'server-only';

import { execFile } from 'child_process';
import { promisify } from 'util';

import { getCurrentAppVersion } from '@/app/lib/migration/app-version';
import {
  MIGRATION_BUNDLE_SCHEMA_VERSION,
  MIGRATION_COMPONENT_KEYS,
  MIGRATION_EXPORT_PROFILES,
  type CanvasMigrationManifest,
  type MigrationComponentKey,
  type MigrationComponents,
  type MigrationExportProfile,
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
  getDatabaseProvider,
  getDeploymentMode,
  openOrganizationBootstrapDatabase,
} from '@/app/lib/organization/bootstrap';

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

type LocalUser = {
  id: string;
  email: string | null;
};

type LocalWorkspace = {
  id: string;
  organizationId: string;
  type: string;
  ownerUserId: string | null;
  rootRelativePath: string;
  displayName: string;
};

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

function readLocalImportContext(warnings: string[]): LocalImportContext {
  const fallback: LocalImportContext = {
    databaseProvider: getDatabaseProvider(),
    deploymentMode: getDeploymentMode(),
    organizationId: null,
    teamFeaturesEnabled: false,
    users: [],
    workspaces: [],
  };

  let sqlite: ReturnType<typeof openOrganizationBootstrapDatabase> | null = null;
  try {
    sqlite = openOrganizationBootstrapDatabase();
    const organization = sqlite.prepare(`
      SELECT organization_id AS organizationId, deployment_mode AS deploymentMode, team_features_enabled AS teamFeaturesEnabled
      FROM canvas_organization_settings
      ORDER BY created_at ASC
      LIMIT 1
    `).get() as { organizationId: string; deploymentMode: string; teamFeaturesEnabled: number } | undefined;
    const users = sqlite.prepare(`
      SELECT id, email
      FROM user
      ORDER BY created_at ASC
    `).all() as LocalUser[];
    const workspaces = sqlite.prepare(`
      SELECT
        id,
        organization_id AS organizationId,
        type,
        owner_user_id AS ownerUserId,
        root_relative_path AS rootRelativePath,
        display_name AS displayName
      FROM canvas_workspaces
      WHERE status = 'active'
      ORDER BY created_at ASC
    `).all() as LocalWorkspace[];

    return {
      databaseProvider: getDatabaseProvider(),
      deploymentMode: organization?.deploymentMode || getDeploymentMode(),
      organizationId: organization?.organizationId || null,
      teamFeaturesEnabled: organization ? organization.teamFeaturesEnabled === 1 : false,
      users,
      workspaces,
    };
  } catch (error) {
    warnings.push(`Target mapping context could not be read: ${error instanceof Error ? error.message : 'unknown error'}`);
    return fallback;
  } finally {
    sqlite?.close();
  }
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
}): MigrationImportUserMapping[] {
  const candidates = new Map<string, { userId: string | null; email: string | null; required: boolean; reason: string }>();
  const addCandidate = (input: { userId: string | null; email: string | null; required: boolean; reason: string }) => {
    if (!input.userId && !input.email) return;
    const key = `${input.userId || ''}:${input.email || ''}`;
    const existing = candidates.get(key);
    if (existing) {
      existing.required ||= input.required;
      existing.reason = existing.required ? existing.reason : input.reason;
      return;
    }
    candidates.set(key, input);
  };

  addCandidate({
    userId: params.manifest.source?.createdByUserId ?? null,
    email: params.manifest.source?.createdByEmail ?? null,
    required: params.manifest.components.database,
    reason: 'Export creator and actor references from the source bundle.',
  });

  for (const archivePath of params.archivePaths) {
    const personalMatch = /^data\/workspaces\/personal\/([^/]+)\/files(?:\/|$)/u.exec(archivePath);
    if (!personalMatch?.[1]) continue;
    addCandidate({
      userId: personalMatch[1],
      email: null,
      required: true,
      reason: 'Personal workspace files require an explicit target user mapping.',
    });
  }

  return [...candidates.values()].map((candidate) => {
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
  archivePaths: string[];
  target: LocalImportContext;
  users: MigrationImportUserMapping[];
}): MigrationImportWorkspaceMapping[] {
  const roots = new Map<string, MigrationImportWorkspaceMapping>();
  const teamWorkspace = params.target.workspaces.find((workspace) => workspace.type === 'team' && workspace.organizationId === params.target.organizationId) || null;

  for (const archivePath of params.archivePaths) {
    if (archivePath.startsWith('data/workspace/')) {
      roots.set('legacy:data/workspace', {
        kind: 'legacy',
        sourcePath: 'data/workspace',
        sourceWorkspaceId: null,
        sourceOrganizationId: null,
        sourceOwnerUserId: null,
        targetWorkspaceId: null,
        targetPath: 'data/workspace',
        status: 'mapped',
        required: false,
        reason: 'Legacy workspace paths are restored without ID mapping.',
      });
    }

    const scopedMatch = /^data\/workspaces\/(team|personal|project)\/([^/]+)\/files(?:\/|$)/u.exec(archivePath);
    if (!scopedMatch?.[1] || !scopedMatch[2]) continue;
    const [, kind, id] = scopedMatch;
    const key = `${kind}:${id}`;
    if (roots.has(key)) continue;

    if (kind === 'team') {
      const sourcePath = `data/workspaces/team/${id}/files`;
      if (teamWorkspace && params.target.organizationId === id) {
        roots.set(key, {
          kind: 'team',
          sourcePath,
          sourceWorkspaceId: null,
          sourceOrganizationId: id,
          sourceOwnerUserId: null,
          targetWorkspaceId: teamWorkspace.id,
          targetPath: `data/${teamWorkspace.rootRelativePath}`,
          status: 'mapped',
          required: true,
          reason: 'Team workspace organization ID matches the target organization.',
        });
      } else {
        roots.set(key, {
          kind: 'team',
          sourcePath,
          sourceWorkspaceId: null,
          sourceOrganizationId: id,
          sourceOwnerUserId: null,
          targetWorkspaceId: teamWorkspace?.id ?? null,
          targetPath: teamWorkspace ? `data/${teamWorkspace.rootRelativePath}` : null,
          status: teamWorkspace ? 'proposed' : 'unresolved',
          required: true,
          reason: teamWorkspace
            ? 'Team workspace requires organization remapping before this restore engine can apply it safely.'
            : 'Target instance has no active team workspace for this bundle.',
        });
      }
    }

    if (kind === 'personal') {
      const sourcePath = `data/workspaces/personal/${id}/files`;
      const userMapping = params.users.find((mapping) => mapping.sourceUserId === id);
      const personalWorkspace = userMapping?.targetUserId
        ? params.target.workspaces.find((workspace) => workspace.type === 'personal' && workspace.ownerUserId === userMapping.targetUserId)
        : null;
      const mapsWithoutRewrite = userMapping?.status === 'mapped' && userMapping.targetUserId === id && personalWorkspace?.rootRelativePath === `workspaces/personal/${id}/files`;
      roots.set(key, {
        kind: 'personal',
        sourcePath,
        sourceWorkspaceId: null,
        sourceOrganizationId: null,
        sourceOwnerUserId: id,
        targetWorkspaceId: personalWorkspace?.id ?? null,
        targetPath: personalWorkspace ? `data/${personalWorkspace.rootRelativePath}` : null,
        status: mapsWithoutRewrite ? 'mapped' : userMapping?.targetUserId ? 'proposed' : 'unresolved',
        required: true,
        reason: mapsWithoutRewrite
          ? 'Personal workspace owner matches an existing target user and path.'
          : 'Personal workspace requires explicit user/path remapping before restore.',
      });
    }

    if (kind === 'project') {
      roots.set(key, {
        kind: 'project',
        sourcePath: `data/workspaces/project/${id}/files`,
        sourceWorkspaceId: id,
        sourceOrganizationId: null,
        sourceOwnerUserId: null,
        targetWorkspaceId: null,
        targetPath: null,
        status: 'unresolved',
        required: true,
        reason: 'Project workspace remapping is not implemented in the V1 restore engine.',
      });
    }
  }

  return [...roots.values()].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
}

function buildDryRun(params: {
  manifest: CanvasMigrationManifest;
  entries: string[];
  reconnect: MigrationImportReconnectRequirement[];
  warnings: string[];
}): MigrationImportDryRun {
  const target = readLocalImportContext(params.warnings);
  const archivePaths = sourceArchivePaths(params.manifest, params.entries);
  const users = buildUserMappings({ manifest: params.manifest, archivePaths, target });
  const workspaces = buildWorkspaceMappings({ archivePaths, target, users });
  const blockers: string[] = [];

  if (params.manifest.components.database) {
    const sourceProvider = params.manifest.source?.databaseProvider ?? 'sqlite';
    if (sourceProvider !== 'sqlite') {
      blockers.push(`Source database provider ${sourceProvider} is not supported by the V1 restore engine.`);
    }
    if (target.databaseProvider !== 'sqlite') {
      blockers.push(`Target database provider ${target.databaseProvider} requires a provider-aware import path before database restore.`);
    }
  }

  for (const mapping of users) {
    if (mapping.required && mapping.status !== 'mapped') {
      blockers.push(`User mapping unresolved: ${mapping.sourceEmail || mapping.sourceUserId || 'unknown user'}.`);
    }
  }
  for (const mapping of workspaces) {
    if (mapping.required && mapping.status !== 'mapped') {
      blockers.push(`Workspace mapping unresolved: ${mapping.sourcePath}.`);
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
  let reconnect: MigrationImportReconnectRequirement[] = [];
  if (manifest?.components.secrets || manifest?.security?.secretsMode === 'reconnect_manifest') {
    const rawReconnect = await unzipText(['-p', params.archivePath, 'data/reconnect-manifest.json'], 20 * 1024 * 1024)
      .catch(() => null);
    reconnect = parseReconnectManifest(rawReconnect);
    if (manifest.components.secrets && reconnect.length === 0) {
      warnings.push('Secrets were selected in the source export, but no reconnect manifest was found.');
    }
  }
  const dryRun = manifest
    ? buildDryRun({ manifest, entries, reconnect, warnings })
    : undefined;
  if (dryRun && !dryRun.canApply) {
    warnings.push('Import dry run is blocked. Resolve required user/workspace mappings before staging restore.');
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
