'use client';

import { useTranslations } from 'next-intl';
import { useFileWatcherContext } from '@/app/hooks/FileWatcherContext';
import { getFileWatcherClient } from '@/app/lib/file-watcher/client';
import { useFileStore } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { Button } from '@/components/ui/button';
import { useDelayedFlag } from '@/app/hooks/useDelayedFlag';

export function FileSyncStatus({ includeTreeStatus = false }: { includeTreeStatus?: boolean }) {
  const t = useTranslations('notebook');
  const { isConnected } = useFileWatcherContext();
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const error = useFileStore((state) => state.treeError);
  const refreshing = useFileStore((state) => state.directoryLoadStates['.'] === 'refreshing');
  const showRefreshing = useDelayedFlag(refreshing);
  if (!workspaceId) return null;
  if (!includeTreeStatus && isConnected) return null;
  return <div role="status" aria-live={!isConnected || error ? 'polite' : 'off'} className="flex h-8 shrink-0 items-center justify-between gap-2 border-b px-3 text-xs text-muted-foreground">
    <span className="min-w-0 truncate" title={error || undefined}>{!isConnected ? t('liveUpdatesUnavailable')
      : error || (showRefreshing ? t('refreshingFolder') : t('liveUpdatesConnected'))}</span>
    {!isConnected ? <Button variant="ghost" size="sm" onClick={() => getFileWatcherClient().reconnectNow()}>{t('reconnectLiveUpdates')}</Button>
      : error && <Button variant="ghost" size="sm" onClick={() => void useFileStore.getState().refreshVisibleTree()}>{t('retryFileReveal')}</Button>}
  </div>;
}
