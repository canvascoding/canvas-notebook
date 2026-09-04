'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ChevronsUpDown,
  Download,
  FolderArchive,
  HardDrive,
  Loader2,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { WorkspaceIdentityMark } from '@/app/components/workspaces/WorkspaceIdentityMark';
import {
  getWorkspaceKindLabel,
  type WorkspaceKindLabels,
} from '@/app/components/workspaces/workspace-utils';
import { canExportWorkspaceFiles } from '@/app/lib/workspaces/export-access';
import type { ClientWorkspaceSummary } from '@/app/lib/workspaces/client-types';
import { useWorkspaceStore } from '@/app/store/workspace-store';

interface WorkspaceStats {
  fileCount: number;
  totalSize: number;
  totalSizeHuman: string;
}

interface WorkspaceExportCardProps {
  isAdmin?: boolean;
}

interface WorkspaceStatsResult {
  requestKey: string;
  stats: WorkspaceStats | null;
  error: string | null;
}

const WORKSPACE_TYPE_ORDER: Record<ClientWorkspaceSummary['type'], number> = {
  personal: 0,
  organization: 1,
  team: 2,
  project: 3,
};

export function WorkspaceExportCard({ isAdmin = false }: WorkspaceExportCardProps) {
  const t = useTranslations('settings.workspacePanel');
  const workspaceTypesT = useTranslations('workspaces.types');
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [statsResult, setStatsResult] = useState<WorkspaceStatsResult | null>(null);
  const [statsRefreshVersion, setStatsRefreshVersion] = useState(0);
  const [activeDownload, setActiveDownload] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const isWorkspaceListLoading = useWorkspaceStore((state) => state.isLoading);
  const workspaceListInitialized = useWorkspaceStore((state) => state.initialized);
  const workspaceListError = useWorkspaceStore((state) => state.error);
  const hydrateWorkspaces = useWorkspaceStore((state) => state.hydrateWorkspaces);

  const kindLabels = {
    personal: workspaceTypesT('personal'),
    organization: workspaceTypesT('organization'),
    team: workspaceTypesT('team'),
    project: workspaceTypesT('project'),
  } satisfies WorkspaceKindLabels;

  const selectableWorkspaces = useMemo(
    () => workspaces
      .filter((workspace) => workspace.status === 'active' && workspace.permissions.canRead)
      .sort((left, right) => {
        if (left.id === activeWorkspaceId) return -1;
        if (right.id === activeWorkspaceId) return 1;
        return WORKSPACE_TYPE_ORDER[left.type] - WORKSPACE_TYPE_ORDER[right.type]
          || left.name.localeCompare(right.name);
      }),
    [activeWorkspaceId, workspaces],
  );

  const effectiveSelectedWorkspaceId = useMemo(() => {
    if (selectedWorkspaceId && selectableWorkspaces.some((workspace) => workspace.id === selectedWorkspaceId)) {
      return selectedWorkspaceId;
    }
    if (activeWorkspaceId && selectableWorkspaces.some((workspace) => workspace.id === activeWorkspaceId)) {
      return activeWorkspaceId;
    }
    return selectableWorkspaces[0]?.id || null;
  }, [activeWorkspaceId, selectableWorkspaces, selectedWorkspaceId]);

  const selectedWorkspace = useMemo(
    () => selectableWorkspaces.find((workspace) => workspace.id === effectiveSelectedWorkspaceId) || null,
    [effectiveSelectedWorkspaceId, selectableWorkspaces],
  );

  const canExportSelectedWorkspace = Boolean(selectedWorkspace && canExportWorkspaceFiles({
    workspaceType: selectedWorkspace.type,
    isPersonalOwner: selectedWorkspace.type === 'personal' && selectedWorkspace.permissions.canManageWorkspace,
    isInstanceAdmin: isAdmin,
    canRead: selectedWorkspace.permissions.canRead,
    status: selectedWorkspace.status,
  }));

  useEffect(() => {
    void hydrateWorkspaces();
  }, [hydrateWorkspaces]);

  const statsRequestKey = selectedWorkspace
    ? `${selectedWorkspace.id}:${statsRefreshVersion}`
    : '';
  const currentStatsResult = statsResult?.requestKey === statsRequestKey ? statsResult : null;
  const stats = currentStatsResult?.stats || null;
  const statsError = currentStatsResult?.error || null;
  const isStatsLoading = Boolean(selectedWorkspace && canExportSelectedWorkspace && !currentStatsResult);

  useEffect(() => {
    if (!selectedWorkspace || !canExportSelectedWorkspace) return;

    const controller = new AbortController();
    const requestKey = statsRequestKey;
    const query = new URLSearchParams({
      scope: 'workspace',
      workspaceId: selectedWorkspace.id,
    });

    void fetch(`/api/files/workspace-stats?${query.toString()}`, {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok || !payload.success) {
          throw new Error(payload.error || t('errors.loadStats'));
        }
        return payload.data as WorkspaceStats;
      })
      .then((nextStats) => {
        setStatsResult({ requestKey, stats: nextStats, error: null });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setStatsResult({
          requestKey,
          stats: null,
          error: err instanceof Error ? err.message : t('errors.loadStats'),
        });
      });

    return () => controller.abort();
  }, [canExportSelectedWorkspace, selectedWorkspace, statsRequestKey, t]);

  const handleDownload = () => {
    if (!selectedWorkspace || !canExportSelectedWorkspace) return;

    setActiveDownload(selectedWorkspace.id);
    setDownloadError(null);
    try {
      const query = new URLSearchParams({
        scope: 'workspace',
        workspaceId: selectedWorkspace.id,
        download: '1',
      });
      const anchor = document.createElement('a');
      anchor.href = `/api/files/download?${query.toString()}`;
      anchor.download = 'workspace.zip';
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : t('errors.downloadFailed'));
    } finally {
      window.setTimeout(() => setActiveDownload(null), 2000);
    }
  };

  const selectedIsActive = selectedWorkspace?.id === activeWorkspaceId;
  const selectedIsPersonal = selectedWorkspace?.type === 'personal';
  const isDownloadingSelected = activeDownload === selectedWorkspace?.id;

  return (
    <Card>
      <CardHeader className="px-4 sm:px-6">
        <CardTitle>{t('workspaceExport.title')}</CardTitle>
        <CardDescription>{t('workspaceExport.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 px-4 pb-4 sm:px-6 sm:pb-6">
        <div className="space-y-2">
          <label className="text-sm font-semibold" htmlFor="workspace-export-selection">
            {t('workspaceExport.stepSelect')}
          </label>
          <div className="relative">
            <select
              id="workspace-export-selection"
              value={effectiveSelectedWorkspaceId || ''}
              onChange={(event) => {
                setSelectedWorkspaceId(event.target.value || null);
                setDownloadError(null);
              }}
              disabled={isWorkspaceListLoading || selectableWorkspaces.length === 0}
              className="h-11 w-full appearance-none rounded-md border border-input bg-background px-3 pr-10 text-sm shadow-xs outline-none transition-colors hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {selectableWorkspaces.length === 0 ? (
                <option value="">{t('workspaceExport.noWorkspaces')}</option>
              ) : null}
              {selectableWorkspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name} - {getWorkspaceKindLabel(workspace, kindLabels)}
                </option>
              ))}
            </select>
            <ChevronsUpDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          </div>

          {isWorkspaceListLoading && !workspaceListInitialized ? (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('workspaceExport.loadingWorkspaces')}
            </div>
          ) : workspaceListError && selectableWorkspaces.length === 0 ? (
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {workspaceListError}
            </p>
          ) : selectedWorkspace ? (
            <div className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                <WorkspaceIdentityMark workspace={selectedWorkspace} className="h-7 w-7" iconClassName="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{selectedWorkspace.name}</p>
                <p className="text-xs text-muted-foreground">{getWorkspaceKindLabel(selectedWorkspace, kindLabels)}</p>
              </div>
              <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                {selectedIsActive ? <Badge variant="secondary">{t('workspaceExport.active')}</Badge> : null}
                <Badge variant="outline">
                  {t(selectedIsPersonal ? 'workspaceExport.personalExport' : 'workspaceExport.adminExport')}
                </Badge>
              </div>
            </div>
          ) : null}
        </div>

        {selectedWorkspace && !canExportSelectedWorkspace ? (
          <div className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-100">
            <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">{t('workspaceExport.adminOnlyTitle')}</p>
              <p className="mt-1 text-xs opacity-80">{t('workspaceExport.adminOnlyDescription')}</p>
            </div>
          </div>
        ) : null}

        {selectedWorkspace && canExportSelectedWorkspace ? (
          <div className="space-y-3">
            <p className="text-sm font-semibold">{t('workspaceExport.stepExport')}</p>
            {isStatsLoading ? (
              <div className="flex items-center py-4 text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('loadingStats')}
              </div>
            ) : statsError && !stats ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {statsError}
              </p>
            ) : stats ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="flex items-center gap-3 rounded-md border border-border p-4">
                    <HardDrive className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{t('totalSize')}</p>
                      <p className="text-2xl font-bold">{stats.totalSizeHuman}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 rounded-md border border-border p-4">
                    <FolderArchive className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{t('fileCount')}</p>
                      <p className="text-2xl font-bold">{stats.fileCount.toLocaleString()}</p>
                    </div>
                  </div>
                </div>

                {downloadError ? <p className="text-sm text-destructive">{downloadError}</p> : null}

                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                  <Button
                    type="button"
                    className="w-full justify-center sm:w-auto"
                    onClick={handleDownload}
                    disabled={activeDownload !== null || stats.fileCount === 0}
                  >
                    {isDownloadingSelected ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="mr-2 h-4 w-4" />
                    )}
                    {isDownloadingSelected ? t('downloading') : t('downloadZip')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-center sm:w-auto"
                    onClick={() => setStatsRefreshVersion((version) => version + 1)}
                    disabled={isStatsLoading}
                  >
                    <RefreshCw className="mr-2 h-4 w-4" />
                    {t('refresh')}
                  </Button>
                </div>

                <p className="text-sm text-muted-foreground">
                  {t(selectedIsPersonal ? 'workspaceExport.personalHint' : 'workspaceExport.sharedHint')}
                </p>
                {stats.fileCount === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('emptyWorkspace')}</p>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}

        {isAdmin ? (
          <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-sm font-semibold">{t('workspaceExport.fullExportTitle')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('workspaceExport.fullExportDescription')}</p>
              </div>
            </div>
            <Button asChild type="button" variant="outline" className="w-full justify-center sm:w-auto">
              <a href="?tab=data-migration">{t('workspaceExport.fullExportAction')}</a>
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
