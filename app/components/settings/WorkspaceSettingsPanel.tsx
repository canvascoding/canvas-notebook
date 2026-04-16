'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Download, FolderArchive, HardDrive, Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface WorkspaceStats {
  fileCount: number;
  totalSize: number;
  totalSizeHuman: string;
}

export function WorkspaceSettingsPanel() {
  const t = useTranslations('settings');
  const [stats, setStats] = useState<WorkspaceStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    void loadStats();
  }, [loadStats]);

  const handleDownload = async () => {
    setIsDownloading(true);
    setError(null);
    try {
      const url = '/api/files/download?path=/&download=1';
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'workspace.zip';
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('workspacePanel.errors.downloadFailed');
      setError(message);
    } finally {
      setTimeout(() => setIsDownloading(false), 2000);
    }
  };

  return (
    <div className="space-y-4">
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

              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={handleDownload} disabled={isDownloading || stats.fileCount === 0}>
                  {isDownloading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="mr-2 h-4 w-4" />
                  )}
                  {isDownloading ? t('workspacePanel.downloading') : t('workspacePanel.downloadZip')}
                </Button>
                <Button type="button" variant="outline" onClick={() => void loadStats()} disabled={isLoading}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {t('workspacePanel.refresh')}
                </Button>
              </div>

              {stats.fileCount === 0 && (
                <p className="text-sm text-muted-foreground">{t('workspacePanel.emptyWorkspace')}</p>
              )}
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}