'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { FileClock, FileQuestion, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  type FileVersionMutation,
} from '@/app/lib/file-version-center/action-client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FileVersionCenterClientError, resolveFileVersionCenterWhenReady } from '@/app/lib/file-version-center/client';
import { FILE_VERSION_CENTER_CONTRACT_VERSION } from '@/app/lib/file-version-center/contracts/v1';
import type {
  FileVersionCenterRequestV1,
  FileVersionTimelineEntryV1,
  FileVersionTimelineResponseV1,
} from '@/app/lib/file-version-center/contracts/v1';
import { loadFileVersionTimelinePage } from '@/app/lib/file-version-center/timeline-client';
import {
  mergeFileVersionTimelinePage,
  reconcileFileVersionTimelineSelection,
} from '@/app/lib/file-version-center/timeline-state';
import {
  claimFileChangeReviewAcknowledgement,
  closeVersionCenter,
  openVersionCenter,
  releaseFileChangeReviewAcknowledgement,
  selectVersionCenterEntry,
  syncVersionCenterFromLocation,
  useFileVersionCenterStore,
} from '@/app/store/file-version-center-store';
import { updateNotification } from '@/app/components/notifications/notification-actions';

import { getFileWatcherClient, type FileEvent } from '@/app/lib/file-watcher/client';
import { authClient } from '@/app/lib/auth-client';
import { openedDocumentAuthScope, subscribeOpenedDocumentAuthInvalidation } from '@/app/lib/collaboration/opened-document-registry';
import { useEditorStore } from '@/app/store/editor-store';
import { useFileStore } from '@/app/store/file-store';
import { useRouter } from '@/i18n/navigation';
import { invalidateReviewQueries } from '@/app/lib/queries/review-queries';
import { FileVersionLoadingSkeleton } from './FileVersionLoadingSkeleton';
import { FileVersionComparison } from './FileVersionComparison';
import { FileVersionTimeline } from './FileVersionTimeline';

function subscribeFileVersionAuth(listener: () => void): () => void {
  // Initial session hydration is not a revocation, but it still changes the
  // partition of a review opened before the authentication atom resolves.
  const unsubscribeSession = authClient.$store.atoms.session.listen(listener);
  const unsubscribeInvalidation = subscribeOpenedDocumentAuthInvalidation(listener);
  return () => { unsubscribeSession(); unsubscribeInvalidation(); };
}

export function FileVersionCenterHost() {
  const t = useTranslations('fileVersionCenter');
  const router = useRouter();
  const request = useFileVersionCenterStore((state) => state.request);
  const authScope = useSyncExternalStore(subscribeFileVersionAuth, openedDocumentAuthScope, () => null);
  const targetIdentity = request ? JSON.stringify([authScope, request.target]) : null;
  const [resolvedTimeline, setResolvedTimeline] = useState<{ identity: string; value: FileVersionTimelineResponseV1 } | null>(null);
  const [failure, setFailure] = useState<{ identity: string; message: string } | null>(null);
  const timeline = resolvedTimeline?.identity === targetIdentity ? resolvedTimeline.value : null;
  const error = failure?.identity === targetIdentity ? failure.message : null;
  const [invalidatedTarget, setInvalidatedTarget] = useState<string | null>(null);
  const invalidationRevisionRef = useRef(0);
  const editorPath = useEditorStore((state) => state.activePath);
  const editorDirty = useEditorStore((state) => state.isDirty);
  const editorWorkspaceId = useFileStore((state) => state.currentFileWorkspaceId);
  const unsavedReviewDocument = Boolean(timeline && editorDirty
    && editorPath === timeline.document.path && editorWorkspaceId === timeline.document.workspaceId);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const paginationAbortRef = useRef<AbortController | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async (
    activeRequest: FileVersionCenterRequestV1,
    signal?: AbortSignal,
    options?: { preserveTimeline?: boolean },
  ) => {
    const generation = ++requestGenerationRef.current;
    const identity = JSON.stringify([authScope, activeRequest.target]);
    const invalidationRevision = invalidationRevisionRef.current;
    const isCurrent = () => generation === requestGenerationRef.current && !signal?.aborted
      && openedDocumentAuthScope() === authScope;
    paginationAbortRef.current?.abort();
    paginationAbortRef.current = null;
    setLoading(true);
    setFailure(null);
    setLoadMoreError(null);
    setLoadingMore(false);
    let resolvingRequest = activeRequest;
    try {
      if (options?.preserveTimeline) await invalidateReviewQueries(activeRequest.target.workspaceId);
      if (!isCurrent()) return;
      for (;;) {
        try {
          const next = await resolveFileVersionCenterWhenReady(resolvingRequest, signal);
          if (!isCurrent()) return;
          if (next.document.workspaceId !== resolvingRequest.target.workspaceId) {
            throw new Error('The resolved document belongs to another workspace.');
          }
          setResolvedTimeline({ identity, value: next });
          if (invalidationRevision === invalidationRevisionRef.current) setInvalidatedTarget(null);
          return;
        } catch (loadError) {
          if (!isCurrent()
            || (loadError instanceof DOMException && loadError.name === 'AbortError')) return;
          if (loadError instanceof FileVersionCenterClientError
            && loadError.code === 'FVRC_STALE_SELECTION') {
            window.dispatchEvent(new CustomEvent('notification_summary_updated'));
            const latestRequest = useFileVersionCenterStore.getState().request;
            if (latestRequest?.target === activeRequest.target
              && latestRequest.source === activeRequest.source
              && latestRequest.selectedEntry?.kind === resolvingRequest.selectedEntry?.kind
              && latestRequest.selectedEntry?.id === resolvingRequest.selectedEntry?.id) {
              // Editor operation summaries are polled. A review can become terminal
              // between the last poll and opening the center, so discard only that
              // stale deep-link selection and reload the authoritative timeline.
              resolvingRequest = openVersionCenter({
                ...resolvingRequest,
                selectedEntry: undefined,
              });
              continue;
            }
          }
          setFailure({ identity, message: loadError instanceof Error ? loadError.message : t('loadFailed') });
          return;
        }
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [authScope, t]);

  const requestTarget = request?.target;
  const requestSource = request?.source;
  const resolutionRequest = useMemo<FileVersionCenterRequestV1 | null>(() => {
    if (!requestTarget || !requestSource) return null;
    const active = useFileVersionCenterStore.getState().request;
    return active?.target === requestTarget && active.source === requestSource ? active : null;
  }, [requestSource, requestTarget]);

  useEffect(() => {
    try {
      syncVersionCenterFromLocation(window.location.search);
    } catch {
      closeVersionCenter();
    }
    const onPopState = () => {
      try {
        syncVersionCenterFromLocation(window.location.search);
      } catch {
        closeVersionCenter();
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!resolutionRequest) {
      requestGenerationRef.current += 1;
      paginationAbortRef.current?.abort();
      return;
    }
    if (!returnFocusRef.current && document.activeElement instanceof HTMLElement) {
      returnFocusRef.current = document.activeElement;
    }
    const controller = new AbortController();
    const begin = window.setTimeout(() => { void load(resolutionRequest, controller.signal); }, 0);
    return () => {
      window.clearTimeout(begin);
      requestGenerationRef.current += 1;
      controller.abort();
      paginationAbortRef.current?.abort();
    };
  }, [load, resolutionRequest]);

  const observedWorkspaceId = timeline?.document.workspaceId;
  const observedPath = timeline?.document.path;
  useEffect(() => {
    if (!targetIdentity || !observedWorkspaceId || !observedPath) return;
    const markChanged = () => {
      invalidationRevisionRef.current += 1;
      setInvalidatedTarget(targetIdentity);
    };
    const fileChanged = useFileStore.subscribe((state, previous) => {
      if (state.currentFileWorkspaceId === observedWorkspaceId && state.currentFile?.path === observedPath
        && previous.currentFileWorkspaceId === observedWorkspaceId && previous.currentFile?.path === observedPath
        && state.currentFile.content !== previous.currentFile.content) markChanged();
    });
    const draftChanged = useEditorStore.subscribe((state, previous) => {
      if (useFileStore.getState().currentFileWorkspaceId === observedWorkspaceId
        && state.activePath === observedPath && previous.activePath === observedPath
        && state.draft !== previous.draft) markChanged();
    });
    const watcher = getFileWatcherClient();
    const fileEvent = (event: Event) => {
      const detail = (event as CustomEvent<FileEvent>).detail;
      if (detail && (!detail.workspaceId || detail.workspaceId === observedWorkspaceId)
        && (detail.relativePath === observedPath || detail.mutation?.oldPath === observedPath)) markChanged();
    };
    watcher.addEventListener('filechange', fileEvent);
    return () => {
      fileChanged();
      draftChanged();
      watcher.removeEventListener('filechange', fileEvent);
    };
  }, [observedPath, observedWorkspaceId, targetIdentity]);

  const selection = useMemo(() => request && timeline
    ? reconcileFileVersionTimelineSelection({ request, timeline })
    : null, [request, timeline]);

  useEffect(() => {
    if (
      request?.target.kind !== 'lineage'
      || request.selectedEntry?.kind !== 'agent_operation'
      || timeline?.document.workspaceId !== request.target.workspaceId
      || timeline.document.lineageId !== request.target.lineageId
      || selection?.state !== 'selected'
      || selection.entry?.kind !== 'agent_operation'
      || selection.entry.operationId !== request.selectedEntry.id
    ) return;
    const acknowledgement = claimFileChangeReviewAcknowledgement({
      request,
      workspaceId: timeline.document.workspaceId,
      lineageId: timeline.document.lineageId,
      operationId: selection.entry.operationId,
    });
    if (!acknowledgement) return;
    void updateNotification({
      action: 'mark_item_read',
      itemId: acknowledgement.itemId,
      workspaceId: acknowledgement.workspaceId,
    }).catch(() => {
      releaseFileChangeReviewAcknowledgement(acknowledgement.generation);
    });
  }, [request, selection, timeline]);

  const selectEntry = useCallback((entry: FileVersionTimelineEntryV1) => {
    selectVersionCenterEntry(entry.kind === 'current' ? null : { kind: entry.kind, id: entry.id });
  }, []);

  const loadMore = useCallback(async () => {
    const activeRequest = request;
    const activeTimeline = timeline;
    const cursor = activeTimeline?.page.nextCursor;
    if (!activeRequest || !activeTimeline?.page.hasMore || !cursor || loadingMore || paginationAbortRef.current) return;
    const generation = requestGenerationRef.current;
    const controller = new AbortController();
    paginationAbortRef.current = controller;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await loadFileVersionTimelinePage({
        contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
        target: activeRequest.target,
        cursor,
        limit: 25,
      }, controller.signal);
      if (generation !== requestGenerationRef.current || controller.signal.aborted
        || openedDocumentAuthScope() !== authScope) return;
      const merged = mergeFileVersionTimelinePage(activeTimeline, page);
      const identity = JSON.stringify([authScope, activeRequest.target]);
      setResolvedTimeline((current) => current?.identity === identity ? { identity, value: merged } : current);
    } catch (pageError) {
      if (generation !== requestGenerationRef.current || controller.signal.aborted
        || (pageError instanceof DOMException && pageError.name === 'AbortError')) return;
      setLoadMoreError(pageError instanceof Error ? pageError.message : t('loadMoreFailed'));
    } finally {
      if (paginationAbortRef.current === controller) paginationAbortRef.current = null;
      if (generation === requestGenerationRef.current) setLoadingMore(false);
    }
  }, [authScope, loadingMore, request, t, timeline]);

  const close = useCallback(() => closeVersionCenter(), []);
  const resolvedPath = timeline?.document.path;
  const targetLabel = resolvedPath ?? (request?.target.kind === 'path'
    ? request.target.pathHint
    : t('resolvingDocument'));

  const invalidateTimeline = useCallback(async (action?: FileVersionMutation) => {
    if (!request || openedDocumentAuthScope() !== authScope) return;
    await invalidateReviewQueries(request.target.workspaceId);
    const activeRequest = useFileVersionCenterStore.getState().request;
    if (!activeRequest || JSON.stringify([authScope, activeRequest.target]) !== targetIdentity) return;
    if (action && activeRequest.selectedEntry?.kind === request.selectedEntry?.kind
      && activeRequest.selectedEntry?.id === request.selectedEntry?.id) selectVersionCenterEntry(null);
    const refreshedRequest = useFileVersionCenterStore.getState().request;
    if (refreshedRequest) await load(refreshedRequest, undefined, { preserveTimeline: true });
  }, [authScope, load, request, targetIdentity]);

  const continueEditing = useCallback(() => {
    if (!timeline) return;
    closeVersionCenter({ syncLocation: false });
    router.push({ pathname: '/notebook', query: {
      workspaceId: timeline.document.workspaceId, path: timeline.document.path, chat: 'open',
    } });
  }, [router, timeline]);

  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => { if (!open) close(); }}>
      {request ? (
        <DialogContent
          layout="viewport"
          data-testid="file-version-center"
          aria-busy={loading || loadingMore}
          onCloseAutoFocus={(event) => {
            const returnFocus = returnFocusRef.current;
            returnFocusRef.current = null;
            if (!returnFocus?.isConnected) return;
            event.preventDefault();
            returnFocus.focus();
          }}
        >
          <DialogHeader className="border-b px-5 py-4 pr-14 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/45 text-muted-foreground">
                <FileClock className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <DialogTitle>{t('title')}</DialogTitle>
                <DialogDescription className="mt-1 truncate" title={resolvedPath}>
                  {targetLabel}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          {error && timeline ? <div role="alert" className="flex items-center justify-between gap-3 border-b px-5 py-3 text-sm">
            <span>{error}</span>
            <Button variant="outline" size="sm" disabled={loading} onClick={() => { void invalidateTimeline(); }}>{t('retry')}</Button>
          </div> : null}
          <div className="flex min-h-0 flex-1 items-center justify-center">
            {!timeline && !error ? (
              <FileVersionLoadingSkeleton label={t('loading')} timeline />
            ) : error && !timeline ? (
              <div role="alert" className="m-6 max-w-md rounded-xl border bg-muted/25 p-5 text-center">
                <p className="text-sm font-medium">{t('loadFailed')}</p>
                <p className="mt-1 text-sm text-muted-foreground">{error}</p>
                <Button
                  className="mt-4"
                  variant="outline"
                  size="sm"
                  onClick={() => { if (request) void load(request); }}
                >
                  <RefreshCw className="size-4" aria-hidden="true" />
                  {t('retry')}
                </Button>
              </div>
            ) : timeline && !timeline.capabilities.history ? (
              <div data-testid="file-version-center-unavailable" className="flex max-w-md flex-col items-center p-6 text-center">
                <span className="flex size-10 items-center justify-center rounded-lg border bg-muted/35 text-muted-foreground">
                  <FileQuestion className="size-4" aria-hidden="true" />
                </span>
                <p className="mt-3 text-sm font-semibold">{t('historyUnavailable')}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {timeline.capabilities.reason === 'rollout_disabled'
                    ? t('historyDisabledDescription')
                    : t('historyUnavailableDescription')}
                </p>
              </div>
            ) : timeline && selection ? (
              <div
                data-testid="file-version-center-responsive-layout"
                className="grid size-full min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)] md:overflow-hidden"
              >
                <FileVersionTimeline
                  timeline={timeline}
                  selection={selection}
                  onSelect={selectEntry}
                  onLoadMore={() => { void loadMore(); }}
                  loadingMore={loadingMore}
                  loadMoreError={loadMoreError}
                />
                <FileVersionComparison
                  request={request}
                  timeline={timeline}
                  selection={selection}
                  onTimelineInvalidate={invalidateTimeline}
                  onContinue={continueEditing}
                  isRevalidating={loading}
                  isStale={Boolean(error) || invalidatedTarget === targetIdentity || unsavedReviewDocument}
                />
              </div>
            ) : null}
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
