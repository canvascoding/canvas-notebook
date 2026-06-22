export const FULL_BACKUP_SCHEMA_VERSION = 1;

export type FullBackupStatus = 'queued' | 'running' | 'completed' | 'failed';

export type FullBackupProvider = 'sqlite' | 'postgres' | 'unknown';

export type FullBackupKind = 'sqlite_snapshot' | 'postgres_dump' | 'none';

export interface FullBackupFileEntry {
  kind: 'database' | 'data';
  archivePath: string;
  size: number;
  modifiedAt: string;
  sha256: string;
}

export interface FullBackupSource {
  databaseProvider: FullBackupProvider;
  deploymentMode: string;
  teamFeaturesEnabled: boolean;
  managedServicesEnabled: boolean;
  organizationId: string | null;
  createdByUserId: string | null;
  createdByEmail: string | null;
  createdByRole: string | null;
}

export interface FullBackupDatabaseManifest {
  provider: FullBackupProvider;
  backupKind: FullBackupKind;
  artifactPath: string | null;
  artifactSha256: string | null;
  postgresVersion: string | null;
  pgvectorEnabled: boolean | null;
  pgvectorVersion: string | null;
}

export interface FullBackupSecurityManifest {
  fullDisasterRecovery: true;
  publicLinksIncluded: true;
  publicLinkTokensIncluded: true;
  rawSecretsIncluded: true;
  unencryptedArchive: true;
  warning: string;
}

export interface FullBackupRestoreManifest {
  requiresPostgres: boolean;
  requiresReindex: boolean;
  preservesTargetInstanceAndLicense: false;
  publicLinksIncluded: true;
}

export interface CanvasFullBackupManifest {
  format: 'canvas-notebook-full-backup';
  backupSchemaVersion: number;
  appVersion: string;
  backupId: string;
  createdAt: string;
  source: FullBackupSource;
  database: FullBackupDatabaseManifest;
  security: FullBackupSecurityManifest;
  restore: FullBackupRestoreManifest;
  fileCount: number;
  totalBytes: number;
  warnings: string[];
  files: FullBackupFileEntry[];
}

export interface FullBackupJob {
  id: string;
  status: FullBackupStatus;
  phase: string;
  createdAt: string;
  updatedAt: string;
  fileName: string;
  filePath?: string;
  archiveSha256?: string;
  error?: string;
  source: FullBackupSource;
  progress: {
    fileCount: number;
    totalBytes: number;
    filesProcessed: number;
    bytesProcessed: number;
  };
  manifest?: CanvasFullBackupManifest;
}

export interface FullBackupInspection {
  backupId: string | null;
  archivePath: string;
  currentDatabaseProvider: FullBackupProvider;
  sourceDatabaseProvider: FullBackupProvider | null;
  canRestore: boolean;
  risks: string[];
  warnings: string[];
  manifest: CanvasFullBackupManifest | null;
}
