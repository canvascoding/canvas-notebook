'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileClock, RefreshCw } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  buildContinueFileVersionHref,
  type FileVersionMutation,
} from '@/app/lib/file-version-center/action-client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { resolveFileVersionCenter } from '@/app/lib/file-version-center/client';
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
  closeVersionCenter,
  selectVersionCenterEntry,
  syncVersionCenterFromLocation,
  useFileVersionCenterStore,
} from '@/app/store/file-version-center-store';

import { FileVersionComparison } from './FileVersionComparison';
import { FileVersionTimeline } from './FileVersionTimeline';

export function FileVersionCenterHost() {
  const t = useTranslations('fileVersionCenter');
  const locale = useLocale();
  const request = useFileVersionCenterStore((state) => state.request);
  const [timeline, setTimeline] = useState<FileVersionTimelineResponseV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    paginationAbortRef.current?.abort();
    setLoading(true);
    setError(null);
    setLoadMoreError(null);
    setLoadingMore(false);
    if (!options?.preserveTimeline) setTimeline(null);
    try {
      const next = await resolveFileVersionCenter(activeRequest, signal);
      if (generation !== requestGenerationRef.current) return;
      if (next.document.workspaceId !== activeRequest.target.workspaceId) {
        throw new Error('The resolved document belongs to another workspace.');
      }
      setTimeline(next);
    } catch (loadError) {
      if (generation !== requestGenerationRef.current
        || (loadError instanceof DOMException && loadError.name === 'AbortError')) return;
      setError(loadError instanceof Error ? loadError.message : t('loadFailed'));
    } finally {
      if (generation === requestGenerationRef.current) setLoading(false);
    }
  }, [t]);

  const requestTarget = request?.target;
  const requestSource = request?.source;
  const resolutionRequest = useMemo<FileVersionCenterRequestV1 | null>(() => requestTarget && requestSource ? ({
    contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
    target: requestTarget,
    initialView: 'history',
    source: requestSource,
  }) : null, [requestSource, requestTarget]);

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
      controller.abort();
      paginationAbortRef.current?.abort();
    };
  }, [load, resolutionRequest]);

  const selection = useMemo(() => request && timeline
    ? reconcileFileVersionTimelineSelection({ request, timeline })
    : null, [request, timeline]);

  const selectEntry = useCallback((entry: FileVersionTimelineEntryV1) => {
    selectVersionCenterEntry(entry.kind === 'current' ? null : { kind: entry.kind, id: entry.id });
  }, []);

  const loadMore = useCallback(async () => {
    const activeRequest = request;
    const activeTimeline = timeline;
    const cursor = activeTimeline?.page.nextCursor;
    if (!activeRequest || !activeTimeline?.page.hasMore || !cursor || loadingMore) return;
    const generation = requestGenerationRef.current;
    const controller = new AbortController();
    paginationAbortRef.current?.abort();
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
      if (generation !== requestGenerationRef.current) return;
      setTimeline((current) => current ? mergeFileVersionTimelinePage(current, page) : page);
    } catch (pageError) {
      if (generation !== requestGenerationRef.current
        || (pageError instanceof DOMException && pageError.name === 'AbortError')) return;
      setLoadMoreError(pageError instanceof Error ? pageError.message : t('loadMoreFailed'));
    } finally {
      if (generation === requestGenerationRef.current) setLoadingMore(false);
    }
  }, [loadingMore, request, t, timeline]);

  const close = useCallback(() => closeVersionCenter(), []);
  const resolvedPath = timeline?.document.path;
  const targetLabel = resolvedPath ?? (request?.target.kind === 'path'
    ? request.target.pathHint
    : t('resolvingDocument'));

  const invalidateTimeline = useCallback(async (action?: FileVersionMutation) => {
    if (action) selectVersionCenterEntry(null);
    const activeRequest = useFileVersionCenterStore.getState().request;
    if (activeRequest) await load(activeRequest, undefined, { preserveTimeline: true });
  }, [load]);

  const continueEditing = useCallback(() => {
    const activeTimeline = timeline;
    if (!activeTimeline) return;
    const href = buildContinueFileVersionHref({
      workspaceId: activeTimeline.document.workspaceId,
      path: activeTimeline.document.path,
      locale,
    });
    closeVersionCenter({ syncLocation: false });
    window.location.assign(href);
  }, [locale, timeline]);

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
          <div className="flex min-h-0 flex-1 items-center justify-center">
            {loading && !timeline ? (
              <div role="status" className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                {t('loading')}
              </div>
            ) : error ? (
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
                />
              </div>
            ) : null}
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
