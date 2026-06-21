export const MIGRATION_BUNDLE_SCHEMA_VERSION = 1;

export const MIGRATION_COMPONENT_KEYS = [
  'database',
  'workspace',
  'studioAssets',
  'studioOutputs',
  'userUploads',
  'agents',
  'skills',
  'secrets',
] as const;

export type MigrationComponentKey = (typeof MIGRATION_COMPONENT_KEYS)[number];

export type MigrationComponents = Record<MigrationComponentKey, boolean>;

export const MIGRATION_EXPORT_PROFILES = ['standard', 'full_admin'] as const;

export type MigrationExportProfile = (typeof MIGRATION_EXPORT_PROFILES)[number];

export const DEFAULT_MIGRATION_COMPONENTS: MigrationComponents = {
  database: true,
  workspace: true,
  studioAssets: true,
  studioOutputs: true,
  userUploads: true,
  agents: true,
  skills: true,
  secrets: false,
};

export const FILE_ONLY_MIGRATION_COMPONENTS: MigrationComponents = {
  database: false,
  workspace: true,
  studioAssets: false,
  studioOutputs: false,
  userUploads: false,
  agents: false,
  skills: false,
  secrets: false,
};

export type MigrationExportStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface MigrationFileEntry {
  component: MigrationComponentKey;
  archivePath: string;
  size: number;
  modifiedAt: string;
}

export interface CanvasMigrationManifest {
  format: 'canvas-notebook-migration';
  bundleSchemaVersion: number;
  appVersion: string;
  exportedAt: string;
  exportId: string;
  exportProfile?: MigrationExportProfile;
  components: MigrationComponents;
  selection?: MigrationExportSelection;
  source?: MigrationExportSource;
  security?: MigrationExportSecurity;
  fileCount: number;
  totalBytes: number;
  warnings: string[];
  files: MigrationFileEntry[];
}

export interface MigrationExportSelection {
  includePersonalWorkspaces: boolean;
  includePublicLinks: false;
  includeRawSecrets: false;
}

export interface MigrationExportSource {
  databaseProvider: string;
  deploymentMode: string;
  teamFeaturesEnabled: boolean;
  managedServicesEnabled: boolean;
  organizationId: string | null;
  createdByUserId: string | null;
  createdByEmail: string | null;
  createdByRole: string | null;
}

export interface MigrationExportSecurity {
  publicLinksIncluded: false;
  publicLinkTokensIncluded: false;
  rawSecretsIncluded: false;
  secretsMode: 'excluded' | 'reconnect_manifest';
  unencryptedArchive: true;
}

export interface MigrationExportOptions {
  components: MigrationComponents;
  profile?: MigrationExportProfile;
  includePersonalWorkspaces?: boolean;
  source?: Partial<MigrationExportSource>;
}

export interface MigrationExportJob {
  id: string;
  status: MigrationExportStatus;
  phase: string;
  profile: MigrationExportProfile;
  components: MigrationComponents;
  selection: MigrationExportSelection;
  source: MigrationExportSource;
  createdAt: string;
  updatedAt: string;
  fileName: string;
  filePath?: string;
  error?: string;
  progress: {
    fileCount: number;
    totalBytes: number;
    filesProcessed: number;
    bytesProcessed: number;
  };
  manifest?: CanvasMigrationManifest;
}

export interface MigrationUploadStatus {
  id: string;
  fileName: string;
  totalBytes: number;
  totalParts: number;
  receivedParts: number[];
  createdAt: string;
  updatedAt: string;
  status: 'receiving' | 'finalizing' | 'completed' | 'failed';
  archivePath?: string;
  archiveSha256?: string;
  error?: string;
  inspection?: MigrationInspection;
}

export type MigrationVersionCompatibility =
  | 'same'
  | 'older_export_allowed'
  | 'newer_export_blocked'
  | 'unsupported_bundle_schema';

export interface MigrationInspection {
  uploadId: string;
  archivePath: string;
  currentAppVersion: string;
  exportAppVersion: string | null;
  compatibility: MigrationVersionCompatibility;
  canRestore: boolean;
  manifest: CanvasMigrationManifest | null;
  dryRun?: MigrationImportDryRun;
  risks: string[];
  warnings: string[];
}

export type MigrationImportMappingStatus = 'mapped' | 'proposed' | 'unresolved' | 'not_required';

export interface MigrationImportUserMapping {
  sourceUserId: string | null;
  sourceEmail: string | null;
  targetUserId: string | null;
  targetEmail: string | null;
  status: MigrationImportMappingStatus;
  required: boolean;
  reason: string;
}

export interface MigrationImportWorkspaceMapping {
  kind: 'legacy' | 'team' | 'personal' | 'project' | 'unknown';
  sourcePath: string;
  sourceWorkspaceId: string | null;
  sourceOrganizationId: string | null;
  sourceOwnerUserId: string | null;
  targetWorkspaceId: string | null;
  targetPath: string | null;
  status: MigrationImportMappingStatus;
  required: boolean;
  reason: string;
}

export interface MigrationImportReconnectRequirement {
  kind: 'env_file' | 'oauth_store' | 'secret_directory' | 'unknown';
  scope: 'legacy' | 'user' | 'organization' | 'system' | 'unknown';
  path: string;
  secretNames: string[];
  required: boolean;
  reason: string;
}

export interface MigrationImportDryRun {
  status: 'ready' | 'attention_required' | 'blocked';
  canApply: boolean;
  blockers: string[];
  source: {
    exportProfile: MigrationExportProfile | null;
    databaseProvider: string | null;
    deploymentMode: string | null;
    organizationId: string | null;
    createdByUserId: string | null;
    createdByEmail: string | null;
  };
  target: {
    databaseProvider: string;
    deploymentMode: string;
    organizationId: string | null;
    teamFeaturesEnabled: boolean;
  };
  users: MigrationImportUserMapping[];
  workspaces: MigrationImportWorkspaceMapping[];
  reconnect: MigrationImportReconnectRequirement[];
  stats: {
    userMappings: number;
    workspaceMappings: number;
    reconnectRequirements: number;
    blockers: number;
  };
}

export interface PendingMigrationRestore {
  id: string;
  uploadId: string;
  archivePath: string;
  requestedAt: string;
  requestedBy: {
    userId: string;
    email: string;
  };
  components: MigrationComponents;
  invalidateSessions: boolean;
  pauseAutomations: boolean;
  clearOAuthTokens: boolean;
  preserveTargetInstanceAndLicense: boolean;
}
