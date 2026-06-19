'use client';

import { useCallback, useEffect, useMemo, useState, startTransition } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Building2,
  Database,
  Download,
  FileArchive,
  FolderArchive,
  HardDrive,
  ImageIcon,
  KeyRound,
  Loader2,
  Puzzle,
  RefreshCw,
  Upload,
  type LucideIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DEFAULT_MIGRATION_COMPONENTS,
  MIGRATION_COMPONENT_KEYS,
  type MigrationComponentKey,
  type MigrationComponents,
  type MigrationExportJob,
  type MigrationInspection,
  type MigrationUploadStatus,
} from '@/app/lib/migration/types';
import {
  getMigrationUploadPartRange,
  getMigrationUploadTotalParts,
} from '@/app/lib/migration/upload-chunks';

interface WorkspaceStats {
  fileCount: number;
  totalSize: number;
  totalSizeHuman: string;
}

interface WorkspaceSettingsPanelProps {
  isAdmin?: boolean;
  organizationPermission?: OrganizationBootstrapStatus['permission'];
}

type DownloadScope = 'workspace' | 'data';

interface OrganizationBootstrapStatus {
  configured: boolean;
  organizationId: string | null;
  ownerUserId: string | null;
  ownerEmail: string | null;
  deploymentMode: string;
  teamFeaturesEnabled: boolean;
  databaseProvider: string;
  permission: {
    role: string;
    canWriteTeamWorkspace: boolean;
    canCreatePublicLinks: boolean;
    canCreateTeamAutomations: boolean;
    canSharePluginsAndSkills: boolean;
    canExport: boolean;
    canDeleteTeamFiles: boolean;
    canDeleteStudioAssets: boolean;
    canManageBackups: boolean;
    canMigrateDatabase: boolean;
    canEnableKnowledge: boolean;
    canRecoverWorkspaces: boolean;
  } | null;
  paths: {
    personalWorkspace: string | null;
    userSettings: string | null;
    userSecrets: string | null;
    organizationRoot: string | null;
    teamWorkspace: string | null;
    systemBackups: string;
  };
  warnings: string[];
}

const COMPONENT_ICONS: Record<MigrationComponentKey, LucideIcon> = {
  database: Database,
  workspace: FolderArchive,
  studioAssets: ImageIcon,
  studioOutputs: FileArchive,
  userUploads: Upload,
  agents: Bot,
  skills: Puzzle,
  secrets: KeyRound,
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function progressPercent(processed: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.round((processed / total) * 100));
}

export function WorkspaceSettingsPanel({ isAdmin = false, organizationPermission = null }: WorkspaceSettingsPanelProps) {
  const t = useTranslations('settings');
  const [stats, setStats] = useState<WorkspaceStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [organizationStatus, setOrganizationStatus] = useState<OrganizationBootstrapStatus | null>(null);
  const [isOrganizationLoading, setIsOrganizationLoading] = useState(isAdmin);
  const [organizationError, setOrganizationError] = useState<string | null>(null);
  const [activeDownload, setActiveDownload] = useState<DownloadScope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [migrationComponents, setMigrationComponents] = useState<MigrationComponents>(() => ({
    ...DEFAULT_MIGRATION_COMPONENTS,
    secrets: false,
  }));
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [migrationMessage, setMigrationMessage] = useState<string | null>(null);
  const [exportJob, setExportJob] = useState<MigrationExportJob | null>(null);
  const [isCreatingExport, setIsCreatingExport] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<MigrationUploadStatus | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);

  const selectedComponentCount = useMemo(
    () => MIGRATION_COMPONENT_KEYS.filter((key) => migrationComponents[key]).length,
    [migrationComponents],
  );

  const inspection: MigrationInspection | undefined = uploadStatus?.inspection;
  const canExportData = organizationPermission?.canExport ?? isAdmin;
  const canRecoverWorkspaces = organizationPermission?.canRecoverWorkspaces ?? isAdmin;

  const loadOrganizationStatus = useCallback(async () => {
    if (!isAdmin) return;
    setIsOrganizationLoading(true);
    setOrganizationError(null);
    try {
      const response = await fetch('/api/admin/organization/status', {
        credentials: 'include',
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('workspacePanel.organization.errors.load'));
      }
      setOrganizationStatus(payload.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('workspacePanel.organization.errors.load');
      setOrganizationError(message);
    } finally {
      setIsOrganizationLoading(false);
    }
  }, [isAdmin, t]);

  const loadStats = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/files/workspace-stats', { credentials: 'include' });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('workspacePanel.errors.loadStats'));
      }
      setStats(payload.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('workspacePanel.errors.loadStats');
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    startTransition(() => { void loadStats(); });
  }, [loadStats]);

  useEffect(() => {
    if (!isAdmin) return;
    startTransition(() => { void loadOrganizationStatus(); });
  }, [isAdmin, loadOrganizationStatus]);

  useEffect(() => {
    if (!exportJob || !['queued', 'running'].includes(exportJob.status)) return;

    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/migration/export/${exportJob.id}`, { credentials: 'include' });
        const payload = await response.json();
        if (response.ok && payload.success) {
          setExportJob(payload.job);
        }
      } catch {
        // Keep the current job visible; the next poll may recover.
      }
    }, 1500);

    return () => window.clearInterval(interval);
  }, [exportJob]);

  const handleDownload = async (scope: DownloadScope) => {
    setActiveDownload(scope);
    setError(null);
    try {
      const url = scope === 'data'
        ? '/api/files/download?scope=data&download=1'
        : '/api/files/download?path=/&download=1';
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = scope === 'data' ? 'data.zip' : 'workspace.zip';
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('workspacePanel.errors.downloadFailed');
      setError(message);
    } finally {
      setTimeout(() => setActiveDownload(null), 2000);
    }
  };

  const toggleMigrationComponent = (key: MigrationComponentKey) => {
    setMigrationComponents((current) => ({
      ...current,
      [key]: !current[key],
    }));
  };

  const createMigrationExport = async () => {
    if (!canExportData) {
      setMigrationError(t('workspacePanel.migration.adminOnly'));
      return;
    }
    setIsCreatingExport(true);
    setMigrationError(null);
    setMigrationMessage(null);
    setExportJob(null);
    try {
      const response = await fetch('/api/migration/export', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ components: migrationComponents }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('workspacePanel.migration.errors.exportFailed'));
      }
      setExportJob(payload.job);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('workspacePanel.migration.errors.exportFailed');
      setMigrationError(message);
    } finally {
      setIsCreatingExport(false);
    }
  };

  const downloadMigrationExport = () => {
    if (!exportJob || exportJob.status !== 'completed') return;
    const anchor = document.createElement('a');
    anchor.href = `/api/migration/export/${exportJob.id}/download`;
    anchor.download = exportJob.fileName;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const uploadMigrationArchive = async (file: File) => {
    if (!canRecoverWorkspaces) {
      setMigrationError(t('workspacePanel.migration.adminOnly'));
      return;
    }

    setIsUploading(true);
    setMigrationError(null);
    setMigrationMessage(null);
    setUploadStatus(null);
    setUploadProgress(0);

    try {
      const totalParts = getMigrationUploadTotalParts(file.size);
      const createResponse = await fetch('/api/migration/uploads', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          totalBytes: file.size,
          totalParts,
        }),
      });
      const createPayload = await createResponse.json();
      if (!createResponse.ok || !createPayload.success) {
        throw new Error(createPayload.error || t('workspacePanel.migration.errors.uploadFailed'));
      }

      const uploadId = createPayload.upload.id as string;
      setUploadStatus(createPayload.upload);

      for (let partIndex = 0; partIndex < totalParts; partIndex++) {
        const { start, end, size } = getMigrationUploadPartRange(file.size, partIndex);
        const partResponse = await fetch(`/api/migration/uploads/${uploadId}?partIndex=${partIndex}&expectedBytes=${size}`, {
          method: 'PUT',
          credentials: 'include',
          body: file.slice(start, end),
        });
        const partPayload = await partResponse.json();
        if (!partResponse.ok || !partPayload.success) {
          throw new Error(partPayload.error || t('workspacePanel.migration.errors.uploadFailed'));
        }
        setUploadStatus(partPayload.upload);
        setUploadProgress(progressPercent(partIndex + 1, totalParts));
      }

      const completeResponse = await fetch(`/api/migration/uploads/${uploadId}/complete`, {
        method: 'POST',
        credentials: 'include',
      });
      const completePayload = await completeResponse.json();
      if (!completeResponse.ok || !completePayload.success) {
        throw new Error(completePayload.error || t('workspacePanel.migration.errors.inspectFailed'));
      }
      setUploadStatus(completePayload.upload);
      setUploadProgress(100);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('workspacePanel.migration.errors.uploadFailed');
      setMigrationError(message);
    } finally {
      setIsUploading(false);
    }
  };

  const restoreMigration = async () => {
    if (!uploadStatus?.inspection?.canRestore) return;
    const confirmation = window.prompt(t('workspacePanel.migration.confirmPrompt'));
    if (confirmation !== 'FULL_RESTORE') {
      setMigrationError(t('workspacePanel.migration.confirmMismatch'));
      return;
    }

    setIsRestoring(true);
    setMigrationError(null);
    setMigrationMessage(null);
    try {
      const response = await fetch('/api/migration/restore', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uploadId: uploadStatus.id,
          confirmation: 'FULL_RESTORE',
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || t('workspacePanel.migration.errors.restoreFailed'));
      }
      setMigrationMessage(payload.restartScheduled
        ? t('workspacePanel.migration.restoreRestarting')
        : t('workspacePanel.migration.restoreRestartRequired'));
    } catch (err) {
      const message = err instanceof Error ? err.message : t('workspacePanel.migration.errors.restoreFailed');
      setMigrationError(message);
    } finally {
      setIsRestoring(false);
    }
  };

  const exportProgress = exportJob
    ? progressPercent(exportJob.progress.bytesProcessed, exportJob.progress.totalBytes)
    : 0;

  return (
    <div className="space-y-4">
      {isAdmin ? (
        <Card>
          <CardHeader className="px-4 sm:px-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <CardTitle className="flex min-w-0 items-center gap-2">
                  <Building2 className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate">{t('workspacePanel.organization.title')}</span>
                </CardTitle>
                <CardDescription>{t('workspacePanel.organization.description')}</CardDescription>
              </div>
              <Button
                type="button"
                variant="outline"
                className="w-full justify-center sm:w-auto"
                onClick={() => void loadOrganizationStatus()}
                disabled={isOrganizationLoading}
              >
                {isOrganizationLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                {t('workspacePanel.organization.refresh')}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
            {isOrganizationLoading && !organizationStatus ? (
              <div className="flex items-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('workspacePanel.organization.loading')}
              </div>
            ) : organizationError ? (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{organizationError}</span>
              </div>
            ) : organizationStatus ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={organizationStatus.configured ? 'default' : 'outline'}>
                    {t(organizationStatus.configured ? 'workspacePanel.organization.ready' : 'workspacePanel.organization.notReady')}
                  </Badge>
                  <Badge variant="outline">{organizationStatus.deploymentMode}</Badge>
                  <Badge variant={organizationStatus.databaseProvider === 'postgres' ? 'default' : 'outline'}>
                    {organizationStatus.databaseProvider}
                  </Badge>
                  <Badge variant={organizationStatus.teamFeaturesEnabled ? 'default' : 'outline'}>
                    {t(organizationStatus.teamFeaturesEnabled ? 'workspacePanel.organization.teamEnabled' : 'workspacePanel.organization.teamDisabled')}
                  </Badge>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="min-w-0 rounded-lg border border-border p-3">
                    <p className="text-xs font-medium uppercase text-muted-foreground">{t('workspacePanel.organization.organizationId')}</p>
                    <p className="mt-1 truncate font-mono text-sm">{organizationStatus.organizationId || '-'}</p>
                  </div>
                  <div className="min-w-0 rounded-lg border border-border p-3">
                    <p className="text-xs font-medium uppercase text-muted-foreground">{t('workspacePanel.organization.owner')}</p>
                    <p className="mt-1 truncate text-sm">{organizationStatus.ownerEmail || organizationStatus.ownerUserId || '-'}</p>
                  </div>
                </div>

                {organizationStatus.permission ? (
                  <div className="space-y-2">
                    <p className="text-sm font-semibold">{t('workspacePanel.organization.criticalRights')}</p>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {[
                        ['canManageBackups', organizationStatus.permission.canManageBackups],
                        ['canMigrateDatabase', organizationStatus.permission.canMigrateDatabase],
                        ['canEnableKnowledge', organizationStatus.permission.canEnableKnowledge],
                        ['canRecoverWorkspaces', organizationStatus.permission.canRecoverWorkspaces],
                        ['canExport', organizationStatus.permission.canExport],
                        ['canCreatePublicLinks', organizationStatus.permission.canCreatePublicLinks],
                        ['canWriteTeamWorkspace', organizationStatus.permission.canWriteTeamWorkspace],
                        ['canDeleteTeamFiles', organizationStatus.permission.canDeleteTeamFiles],
                        ['canDeleteStudioAssets', organizationStatus.permission.canDeleteStudioAssets],
                        ['canCreateTeamAutomations', organizationStatus.permission.canCreateTeamAutomations],
                        ['canSharePluginsAndSkills', organizationStatus.permission.canSharePluginsAndSkills],
                      ].map(([key, enabled]) => (
                        <div key={String(key)} className="flex min-w-0 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                          <CheckCircle2 className={`h-4 w-4 shrink-0 ${enabled ? 'text-green-600' : 'text-muted-foreground'}`} />
                          <span className="min-w-0 truncate">{t(`workspacePanel.organization.permissions.${key}`)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="space-y-2">
                  <p className="text-sm font-semibold">{t('workspacePanel.organization.scopedPaths')}</p>
                  <div className="grid gap-2">
                    {[
                      ['personalWorkspace', organizationStatus.paths.personalWorkspace],
                      ['userSettings', organizationStatus.paths.userSettings],
                      ['userSecrets', organizationStatus.paths.userSecrets],
                      ['organizationRoot', organizationStatus.paths.organizationRoot],
                      ['teamWorkspace', organizationStatus.paths.teamWorkspace],
                      ['systemBackups', organizationStatus.paths.systemBackups],
                    ].map(([key, value]) => (
                      <div key={String(key)} className="grid gap-1 rounded-md border border-border px-3 py-2 text-sm sm:grid-cols-[11rem_minmax(0,1fr)]">
                        <span className="text-muted-foreground">{t(`workspacePanel.organization.paths.${key}`)}</span>
                        <span className="min-w-0 truncate font-mono text-xs">{value || t('workspacePanel.organization.notCreated')}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {organizationStatus.warnings.length > 0 ? (
                  <div className="space-y-2">
                    {organizationStatus.warnings.map((warning) => (
                      <div key={warning} className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{warning}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="px-4 sm:px-6">
          <CardTitle>{t('workspacePanel.title')}</CardTitle>
          <CardDescription>{t('workspacePanel.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 px-4 pb-4 sm:px-6 sm:pb-6">
          {isLoading ? (
            <div className="flex items-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('workspacePanel.loadingStats')}
            </div>
          ) : error && !stats ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : stats ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex items-center gap-3 rounded-lg border border-border p-4">
                  <HardDrive className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{t('workspacePanel.totalSize')}</p>
                    <p className="text-2xl font-bold">{stats.totalSizeHuman}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 rounded-lg border border-border p-4">
                  <FolderArchive className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{t('workspacePanel.fileCount')}</p>
                    <p className="text-2xl font-bold">
                      {stats.fileCount.toLocaleString()}
                    </p>
                  </div>
                </div>
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <Button
                  className="w-full justify-center sm:w-auto"
                  onClick={() => handleDownload('workspace')}
                  disabled={activeDownload !== null || stats.fileCount === 0}
                >
                  {activeDownload === 'workspace' ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="mr-2 h-4 w-4" />
                  )}
                  {activeDownload === 'workspace' ? t('workspacePanel.downloading') : t('workspacePanel.downloadZip')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-center sm:w-auto"
                  onClick={() => handleDownload('data')}
                  disabled={activeDownload !== null || !canExportData}
                >
                  {activeDownload === 'data' ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <FolderArchive className="mr-2 h-4 w-4" />
                  )}
                  {activeDownload === 'data' ? t('workspacePanel.downloading') : t('workspacePanel.downloadDataZip')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-center sm:w-auto"
                  onClick={() => void loadStats()}
                  disabled={isLoading}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t('workspacePanel.refresh')}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">{t(canExportData ? 'workspacePanel.dataZipHint' : 'workspacePanel.adminOnlyHint')}</p>

              {stats.fileCount === 0 && (
                <p className="text-sm text-muted-foreground">{t('workspacePanel.emptyWorkspace')}</p>
              )}
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="px-4 sm:px-6">
          <CardTitle>{t('workspacePanel.migration.title')}</CardTitle>
          <CardDescription>{t('workspacePanel.migration.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 px-4 pb-4 sm:px-6 sm:pb-6">
          {!canExportData && !canRecoverWorkspaces ? (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{t('workspacePanel.migration.adminOnly')}</span>
            </div>
          ) : null}

          <div className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold">{t('workspacePanel.migration.exportTitle')}</h3>
                <p className="text-sm text-muted-foreground">
                  {t('workspacePanel.migration.selectedComponents', { count: selectedComponentCount })}
                </p>
              </div>
              <Button
                type="button"
                className="w-full justify-center sm:w-auto"
                onClick={() => void createMigrationExport()}
                disabled={!canExportData || isCreatingExport || selectedComponentCount === 0 || exportJob?.status === 'running' || exportJob?.status === 'queued'}
              >
                {isCreatingExport || exportJob?.status === 'running' || exportJob?.status === 'queued' ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <FileArchive className="mr-2 h-4 w-4" />
                )}
                {t('workspacePanel.migration.createExport')}
              </Button>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              {MIGRATION_COMPONENT_KEYS.map((key) => {
                const Icon = COMPONENT_ICONS[key];
                return (
                  <label key={key} className="flex min-w-0 items-center gap-3 rounded-lg border border-border p-3 text-sm">
                    <input
                      type="checkbox"
                      checked={migrationComponents[key]}
                      onChange={() => toggleMigrationComponent(key)}
                      disabled={!canExportData}
                      className="h-4 w-4 accent-primary"
                    />
                    <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block font-medium">{t(`workspacePanel.migration.components.${key}.label`)}</span>
                      <span className="block text-xs text-muted-foreground">{t(`workspacePanel.migration.components.${key}.hint`)}</span>
                    </span>
                  </label>
                );
              })}
            </div>

            {migrationComponents.secrets ? (
              <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{t('workspacePanel.migration.secretsWarning')}</span>
              </div>
            ) : null}

            {exportJob ? (
              <div className="space-y-2 rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium">{exportJob.phase}</span>
                  <span className="text-muted-foreground">
                    {formatBytes(exportJob.progress.bytesProcessed)} / {formatBytes(exportJob.progress.totalBytes)}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${exportProgress}%` }} />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{exportJob.progress.filesProcessed.toLocaleString()} / {exportJob.progress.fileCount.toLocaleString()} {t('workspacePanel.migration.files')}</span>
                  <span>{exportProgress}%</span>
                </div>
                {exportJob.status === 'failed' ? (
                  <p className="text-sm text-destructive">{exportJob.error || t('workspacePanel.migration.errors.exportFailed')}</p>
                ) : null}
                {exportJob.status === 'completed' ? (
                  <Button type="button" variant="outline" onClick={downloadMigrationExport}>
                    <Download className="mr-2 h-4 w-4" />
                    {t('workspacePanel.migration.downloadExport')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="space-y-3 border-t border-border pt-4">
            <div>
              <h3 className="text-sm font-semibold">{t('workspacePanel.migration.importTitle')}</h3>
              <p className="text-sm text-muted-foreground">{t('workspacePanel.migration.importDescription')}</p>
            </div>
            <input
              type="file"
              accept=".zip,application/zip"
              disabled={!canRecoverWorkspaces || isUploading || isRestoring}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file) void uploadMigrationArchive(file);
              }}
              className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />

            {isUploading || uploadStatus ? (
              <div className="space-y-2 rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="font-medium">
                    {isUploading ? t('workspacePanel.migration.uploading') : t('workspacePanel.migration.uploadComplete')}
                  </span>
                  <span className="text-muted-foreground">{uploadProgress}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${uploadProgress}%` }} />
                </div>
                {uploadStatus ? (
                  <p className="text-xs text-muted-foreground">
                    {uploadStatus.fileName} · {formatBytes(uploadStatus.totalBytes)}
                  </p>
                ) : null}
              </div>
            ) : null}

            {inspection ? (
              <div className="space-y-3 rounded-lg border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {inspection.canRestore ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 text-destructive" />
                    )}
                    <span>{t(`workspacePanel.migration.compatibility.${inspection.compatibility}`)}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {inspection.exportAppVersion || t('workspacePanel.migration.unknownVersion')} → {inspection.currentAppVersion}
                  </span>
                </div>
                {inspection.manifest ? (
                  <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                    <span>{t('workspacePanel.migration.files')}: {inspection.manifest.fileCount.toLocaleString()}</span>
                    <span>{t('workspacePanel.migration.size')}: {formatBytes(inspection.manifest.totalBytes)}</span>
                    <span>{t('workspacePanel.migration.exportedAt')}: {new Date(inspection.manifest.exportedAt).toLocaleString()}</span>
                  </div>
                ) : null}
                <div className="space-y-1">
                  {inspection.risks.map((risk) => (
                    <p key={risk} className="text-sm text-muted-foreground">- {risk}</p>
                  ))}
                </div>
                {inspection.warnings.map((warning) => (
                  <p key={warning} className="text-sm text-muted-foreground">{warning}</p>
                ))}
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => void restoreMigration()}
                  disabled={!inspection.canRestore || !canRecoverWorkspaces || isRestoring}
                >
                  {isRestoring ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  {t('workspacePanel.migration.restore')}
                </Button>
              </div>
            ) : null}
          </div>

          {migrationError ? <p className="text-sm text-destructive">{migrationError}</p> : null}
          {migrationMessage ? <p className="text-sm text-muted-foreground">{migrationMessage}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
