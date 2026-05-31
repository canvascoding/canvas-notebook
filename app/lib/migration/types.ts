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
  components: MigrationComponents;
  fileCount: number;
  totalBytes: number;
  warnings: string[];
  files: MigrationFileEntry[];
}

export interface MigrationExportOptions {
  components: MigrationComponents;
}

export interface MigrationExportJob {
  id: string;
  status: MigrationExportStatus;
  phase: string;
  components: MigrationComponents;
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
  risks: string[];
  warnings: string[];
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
