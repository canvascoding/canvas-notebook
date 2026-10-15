'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { searchWorkspaceFileReferences, WorkspaceFileApiError,
  type WorkspaceFileReferenceEntry } from '@/app/lib/files/client';

interface SearchOptions {
  workspaceId: string | null;
  query: string;
  enabled: boolean;
  entryType?: 'file' | 'directory' | 'all';
  extensions?: readonly string[];
  limit?: number;
}

interface SearchState {
  identity: string;
  files: WorkspaceFileReferenceEntry[];
  total: number;
  nextCursor: string | null;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
}

export function useWorkspaceFileSearch({ workspaceId, query, enabled, entryType = 'file', extensions = [], limit = 100 }: SearchOptions) {
  const extensionKey = [...extensions].sort().join(',');
  const normalizedQuery = query.trim();
  const identity = JSON.stringify([workspaceId, normalizedQuery, entryType, extensionKey, limit]);
  const [state, setState] = useState<SearchState | null>(null);
  const [revision, setRevision] = useState(0);
  const generationRef = useRef(0);
  const controllersRef = useRef(new Set<AbortController>());
  const forceRefreshRef = useRef(false);

  const runPage = useCallback(async (cursor: string | null, forceRefresh = false) => {
    if (!workspaceId || !enabled) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    const isCurrent = () => !controller.signal.aborted && generationRef.current === generation;
    setState((previous) => cursor && previous?.identity === identity
      ? { ...previous, isLoadingMore: true, error: null }
      : { identity, files: [], total: 0, nextCursor: null, isLoading: true, isLoadingMore: false, error: null });
    try {
      const page = await searchWorkspaceFileReferences({ workspaceId, query: normalizedQuery, entryType,
        extensions: extensionKey ? extensionKey.split(',') : [], limit, cursor, noCache: forceRefresh, signal: controller.signal });
      if (!isCurrent()) return;
      setState((previous) => {
        const rows = cursor && previous?.identity === identity ? [...previous.files, ...page.files] : page.files;
        return { identity, files: [...new Map(rows.map((file) => [file.path, file])).values()],
          total: page.total, nextCursor: page.nextCursor, isLoading: false, isLoadingMore: false, error: null };
      });
    } catch (error) {
      if (!isCurrent()) return;
      if (cursor && error instanceof WorkspaceFileApiError && error.code === 'FILE_SEARCH_CHANGED') {
        setRevision((value) => value + 1);
        return;
      }
      setState((previous) => ({ identity, files: previous?.identity === identity ? previous.files : [],
        total: previous?.identity === identity ? previous.total : 0,
        nextCursor: previous?.identity === identity ? previous.nextCursor : null,
        isLoading: false, isLoadingMore: false, error: error instanceof Error ? error.message : 'Failed to search workspace files' }));
    } finally {
      controllersRef.current.delete(controller);
    }
  }, [enabled, workspaceId, normalizedQuery, entryType, extensionKey, identity, limit]);

  useEffect(() => {
    generationRef.current += 1;
    const controllers = controllersRef.current;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    if (!enabled || !workspaceId) return;
    const forceRefresh = forceRefreshRef.current;
    forceRefreshRef.current = false;
    const timer = window.setTimeout(() => { void runPage(null, forceRefresh); }, 200);
    return () => {
      window.clearTimeout(timer);
      generationRef.current += 1;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
  }, [enabled, workspaceId, identity, revision, runPage]);

  const current = state?.identity === identity && enabled ? state : null;
  const loadMore = useCallback(() => {
    if (state?.identity === identity && state.nextCursor && !state.isLoadingMore && !state.isLoading) {
      void runPage(state.nextCursor);
    }
  }, [identity, state, runPage]);
  const refresh = useCallback(() => {
    forceRefreshRef.current = true;
    setRevision((value) => value + 1);
  }, []);
  return { results: current?.files ?? [], total: current?.total ?? 0, hasMore: Boolean(current?.nextCursor),
    isLoading: current?.isLoading ?? Boolean(enabled && workspaceId), isLoadingMore: current?.isLoadingMore ?? false,
    error: current?.error ?? null, loadMore, refresh };
}
