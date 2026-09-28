'use client';

import { useEffect, useState } from 'react';
import { ArchiveRestore, Loader2, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  listWorkspaceOperationBackups,
  restoreWorkspaceOperationBackupFromClient,
  type WorkspaceOperationBackupListItem,
} from '@/app/lib/files/workspace-operation-backup-client';
import {
  readWorkspaceOperationUndoAvailability,
  undoWorkspaceOperation,
  type WorkspaceOperationUndoAvailability,
} from '@/app/lib/files/workspace-operation-undo-client';
import { useFileStore } from '@/app/store/file-store';

function suggestedRestorePath(originalPath: string): string {
  const slash = originalPath.lastIndexOf('/');
  const prefix = slash < 0 ? '' : originalPath.slice(0, slash + 1);
  const basename = originalPath.slice(slash + 1);
  const extension = basename.lastIndexOf('.');
  return extension > 0
    ? `${prefix}${basename.slice(0, extension)}-restored${basename.slice(extension)}`
    : `${originalPath}-restored`;
}

export function WorkspaceOperationBackupPanel({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('workspaceOperationRecovery');
  const [backups, setBackups] = useState<WorkspaceOperationBackupListItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [targetPath, setTargetPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [undoAvailability, setUndoAvailability] = useState<{
    operationId: string; value: WorkspaceOperationUndoAvailability;
  } | null>(null);
  const [undoneOperationId, setUndoneOperationId] = useState<string | null>(null);
  const [undoReload, setUndoReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [restoredPath, setRestoredPath] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const selected = backups.find((item) => item.backupId === selectedId);
  const selectedOperationId = selected?.status === 'manifest_valid' ? selected.operationId : null;

  useEffect(() => {
    if (!selectedOperationId) return;
    const controller = new AbortController();
    let retryTimer: number | null = null;
    const check = async (retryAfterProjection: boolean) => {
      try {
        const value = await readWorkspaceOperationUndoAvailability(selectedOperationId, workspaceId, controller.signal);
        if (controller.signal.aborted) return;
        if (!retryAfterProjection && value.reasonCode === 'UNDO_CONFLICT') {
          retryTimer = window.setTimeout(() => { void check(true); }, 1500);
          return;
        }
        setUndoAvailability({ operationId: selectedOperationId, value });
      } catch {
        if (!controller.signal.aborted) setUndoAvailability({ operationId: selectedOperationId,
          value: { available: false, reason: null, reasonCode: 'UNDO_UNAVAILABLE', undoOperationId: null } });
      }
    };
    void check(false);
    return () => {
      controller.abort();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [selectedOperationId, undoneOperationId, workspaceId, undoReload]);

  useEffect(() => {
    const controller = new AbortController();
    void listWorkspaceOperationBackups(workspaceId, undefined, controller.signal).then((page) => {
      if (controller.signal.aborted) return;
      setBackups(page.backups);
      setCursor(page.nextCursor);
    }).catch((loadError) => {
      if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : t('loadFailed'));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [reload, t, workspaceId]);

  const refresh = () => {
    setLoading(true);
    setError(null);
    setBackups([]);
    setCursor(null);
    setSelectedId(null);
    setRestoredPath(null);
    setReload((value) => value + 1);
  };

  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await listWorkspaceOperationBackups(workspaceId, cursor);
      setBackups((current) => [...current, ...page.backups]);
      setCursor(page.nextCursor);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('loadFailed'));
    } finally {
      setLoadingMore(false);
    }
  };

  const currentUndoAvailability = undoAvailability && undoAvailability.operationId === selectedOperationId
    ? undoAvailability.value : null;
  const restore = async () => {
    if (!selected || selected.status !== 'manifest_valid' || !targetPath.trim() || restoring) return;
    setRestoring(true);
    setError(null);
    setRestoredPath(null);
    try {
      const result = await restoreWorkspaceOperationBackupFromClient({
        workspaceId, backupId: selected.backupId, targetPath: targetPath.trim(),
      });
      setRestoredPath(result.restoredPath);
      void useFileStore.getState().refreshVisibleTree();
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : t('restoreFailed'));
    } finally {
      setRestoring(false);
    }
  };

  const undo = async () => {
    if (!selectedOperationId || !currentUndoAvailability?.available || undoing) return;
    setUndoing(true);
    setError(null);
    try {
      const result = await undoWorkspaceOperation(selectedOperationId, workspaceId);
      if (result.status !== 'applied') throw new Error(result.status === 'needs_recovery'
        ? `${t('undoNeedsRecovery')} ${result.undoOperationId}` : t('undoFailed'));
      setUndoneOperationId(selectedOperationId);
      setUndoAvailability({ operationId: selectedOperationId, value: { available: false,
        reason: null, reasonCode: 'ALREADY_UNDONE', undoOperationId: result.undoOperationId } });
      void useFileStore.getState().refreshVisibleTree();
    } catch (undoError) {
      setError(undoError instanceof Error ? undoError.message : t('undoFailed'));
    } finally {
      setUndoing(false);
    }
  };

  return <section className="space-y-3 border-t pt-5" aria-label={t('title')} data-testid="workspace-operation-backups">
    <div className="flex items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold">{t('title')}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t('description')}</p>
      </div>
      <Button variant="ghost" size="sm" onClick={refresh}
        disabled={loading || loadingMore || restoring} aria-label={t('refresh')}>
        <RefreshCw className="size-4" />
      </Button>
    </div>

    {loading ? <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <Loader2 className="size-4 animate-spin" />{t('loading')}
    </p> : null}
    {!loading && backups.length === 0 && !error ? <p className="text-sm text-muted-foreground">{t('empty')}</p> : null}
    {backups.length > 0 ? <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-2">
      {backups.map((item) => <button type="button" key={item.backupId}
        disabled={item.status !== 'manifest_valid' || restoring}
        aria-pressed={item.backupId === selectedId}
        className="flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-accent disabled:opacity-60 aria-pressed:bg-accent"
        onClick={() => {
          if (item.status !== 'manifest_valid') return;
          setSelectedId(item.backupId);
          setTargetPath(suggestedRestorePath(item.originalPath));
          setRestoredPath(null);
          setError(null);
        }}>
        <ArchiveRestore className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          {item.status === 'manifest_valid'
            ? <><span className="block break-all font-mono">{item.originalPath}</span>
              <span className="block text-muted-foreground">{new Date(item.capturedAt).toLocaleString()} · {item.sizeBytes.toLocaleString()} B · {t('manualRetention')}</span></>
            : <><span className="block break-all font-mono">{item.backupId}</span>
              <span className="block text-destructive">{t('unavailable')}</span></>}
        </span>
      </button>)}
    </div> : null}

    {cursor ? <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
      {loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}{t('more')}
    </Button> : null}

    {selected?.status === 'manifest_valid' ? <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
      <label htmlFor="workspace-operation-backup-target" className="block text-xs font-medium">{t('targetPath')}</label>
      <Input id="workspace-operation-backup-target" value={targetPath} onChange={(event) => setTargetPath(event.target.value)}
        disabled={restoring} className="font-mono text-xs" />
      <p className="text-xs text-muted-foreground">{t('neverOverwrite')}</p>
      <Button size="sm" disabled={!targetPath.trim() || restoring} onClick={() => void restore()}>
        {restoring ? <Loader2 className="size-4 animate-spin" /> : <ArchiveRestore className="size-4" />}
        {t('restore')}
      </Button>
      <div className="space-y-2 border-t pt-3">
        {selectedOperationId && !currentUndoAvailability ? <p className="text-xs text-muted-foreground" role="status">
          {t('undoChecking')}
        </p> : null}
        {currentUndoAvailability?.available ? <Button variant="outline" size="sm" disabled={undoing || restoring}
          onClick={() => void undo()}>
          {undoing ? <Loader2 className="size-4 animate-spin" /> : null}{t('undo')}
        </Button> : null}
        {currentUndoAvailability?.reasonCode === 'ALREADY_UNDONE' || undoneOperationId === selectedOperationId
          ? <p className="text-xs text-emerald-700 dark:text-emerald-300" role="status">{t('undone')}</p>
          : currentUndoAvailability && !currentUndoAvailability.available
            ? <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t(currentUndoAvailability.reasonCode === 'UNDO_CONFLICT'
                ? 'undoConflict' : 'undoUnavailable')}</p>
              <Button variant="outline" size="sm" onClick={() => {
                setUndoAvailability(null);
                setUndoReload((value) => value + 1);
              }}>{t('undoRetry')}</Button>
            </div> : null}
      </div>
    </div> : null}
    {restoredPath ? <p className="break-all rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm" role="status">
      {t('restored', { path: restoredPath })}
    </p> : null}
    {error ? <p className="break-words rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert">{error}</p> : null}
  </section>;
}
