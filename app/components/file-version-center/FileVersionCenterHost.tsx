'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FileClock, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { resolveFileVersionCenter } from '@/app/lib/file-version-center/client';
import type { FileVersionTimelineResponseV1 } from '@/app/lib/file-version-center/contracts/v1';
import {
  closeVersionCenter,
  syncVersionCenterFromLocation,
  useFileVersionCenterStore,
} from '@/app/store/file-version-center-store';

export function FileVersionCenterHost() {
  const t = useTranslations('fileVersionCenter');
  const request = useFileVersionCenterStore((state) => state.request);
  const [timeline, setTimeline] = useState<FileVersionTimelineResponseV1 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestGenerationRef = useRef(0);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!request) return;
    const generation = ++requestGenerationRef.current;
    setLoading(true);
    setError(null);
    setTimeline(null);
    try {
      const next = await resolveFileVersionCenter(request, signal);
      if (generation !== requestGenerationRef.current) return;
      if (next.document.workspaceId !== request.target.workspaceId) {
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
  }, [request, t]);

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
    if (!request) {
      requestGenerationRef.current += 1;
      return;
    }
    if (!returnFocusRef.current && document.activeElement instanceof HTMLElement) {
      returnFocusRef.current = document.activeElement;
    }
    const controller = new AbortController();
    const begin = window.setTimeout(() => { void load(controller.signal); }, 0);
    return () => {
      window.clearTimeout(begin);
      controller.abort();
    };
  }, [load, request]);

  const close = useCallback(() => closeVersionCenter(), []);
  const resolvedPath = timeline?.document.path;
  const targetLabel = resolvedPath ?? (request?.target.kind === 'path'
    ? request.target.pathHint
    : t('resolvingDocument'));

  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => { if (!open) close(); }}>
      {request ? (
        <DialogContent
          layout="viewport"
          data-testid="file-version-center"
          aria-busy={loading}
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
          <div className="flex min-h-0 flex-1 items-center justify-center p-6">
            {loading ? (
              <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                {t('loading')}
              </div>
            ) : error ? (
              <div role="alert" className="max-w-md rounded-xl border bg-muted/25 p-5 text-center">
                <p className="text-sm font-medium">{t('loadFailed')}</p>
                <p className="mt-1 text-sm text-muted-foreground">{error}</p>
                <Button className="mt-4" variant="outline" size="sm" onClick={() => { void load(); }}>
                  <RefreshCw className="size-4" aria-hidden="true" />
                  {t('retry')}
                </Button>
              </div>
            ) : timeline ? (
              <div className="max-w-lg text-center">
                <p className="text-sm font-medium">{t('documentResolved')}</p>
                <p className="mt-1 text-sm text-muted-foreground">{timeline.document.path}</p>
              </div>
            ) : null}
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
