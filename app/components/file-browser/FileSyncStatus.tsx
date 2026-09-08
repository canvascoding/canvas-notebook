'use client';

import { useTranslations } from 'next-intl';
import { useFileWatcherContext } from '@/app/hooks/FileWatcherContext';
import { getFileWatcherClient } from '@/app/lib/file-watcher/client';
import { useFileStore } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { Button } from '@/components/ui/button';

export function FileSyncStatus({ includeTreeStatus = false }: { includeTreeStatus?: boolean }) {
  const t = useTranslations('notebook');
  const { isConnected } = useFileWatcherContext();
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const error = useFileStore((state) => state.treeError);
  const refreshing = useFileStore((state) => state.directoryLoadStates['.'] === 'refreshing');
  if (!workspaceId) return null;
  if (!isConnected) return <div role="status" className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
    <span>{t('liveUpdatesUnavailable')}</span>
    <Button variant="ghost" size="sm" onClick={() => getFileWatcherClient().reconnectNow()}>{t('reconnectLiveUpdates')}</Button>
  </div>;
  if (!includeTreeStatus || (!error && !refreshing)) return null;
  return <div role="status" className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
    <span>{error || t('refreshingFolder')}</span>
    {error && <Button variant="ghost" size="sm" onClick={() => void useFileStore.getState().refreshVisibleTree()}>{t('retryFileReveal')}</Button>}
  </div>;
}
