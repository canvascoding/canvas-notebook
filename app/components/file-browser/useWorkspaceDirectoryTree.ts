'use client';

import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import { loadWorkspaceTree } from '@/app/lib/files/client';
import { mergeSubtreeChildren } from '@/app/lib/files/tree-utils';
import type { FileNode } from '@/app/lib/files/types';

export function useWorkspaceDirectoryTree(workspaceId: string | null, enabled: boolean) {
  const [state, setState] = useState<{ workspaceId: string | null; tree: FileNode[]; loading: Set<string>; error: string | null }>(
    { workspaceId: null, tree: [], loading: new Set(), error: null });
  const generationRef = useRef(0);
  const controllersRef = useRef(new Map<string, AbortController>());
  const loadDirectory = useCallback(async (directory: string, reset = false) => {
    if (!workspaceId || !enabled) return;
    if (reset) {
      generationRef.current += 1;
      for (const controller of controllersRef.current.values()) controller.abort();
      controllersRef.current.clear();
    }
    const generation = generationRef.current;
    controllersRef.current.get(directory)?.abort();
    const controller = new AbortController();
    controllersRef.current.set(directory, controller);
    const isCurrent = () => !controller.signal.aborted && generationRef.current === generation
      && controllersRef.current.get(directory) === controller;
    setState((previous) => ({ workspaceId, tree: reset || previous.workspaceId !== workspaceId ? [] : previous.tree,
      loading: new Set(reset ? [] : previous.loading).add(directory), error: null }));
    try {
      const children = await loadWorkspaceTree(directory, 0, true, 'Failed to load workspace files', workspaceId,
        { includeStats: false, signal: controller.signal });
      if (!isCurrent()) return;
      setState((previous) => ({ ...previous, tree: directory === '.' ? children
        : mergeSubtreeChildren(previous.tree, directory, children) }));
    } catch (error) {
      if (isCurrent()) setState((previous) => ({ ...previous, error: error instanceof Error ? error.message : 'Failed to load workspace files' }));
    } finally {
      if (isCurrent()) {
        controllersRef.current.delete(directory);
        setState((previous) => { const loading = new Set(previous.loading); loading.delete(directory); return { ...previous, loading }; });
      }
    }
  }, [workspaceId, enabled]);
  const refresh = useCallback(() => loadDirectory('.', true), [loadDirectory]);
  useEffect(() => {
    const controllers = controllersRef.current;
    if (enabled && workspaceId) startTransition(() => { void refresh(); });
    return () => {
      generationRef.current += 1;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
    };
  }, [enabled, workspaceId, refresh]);
  const current = state.workspaceId === workspaceId ? state : null;
  return { tree: current?.tree ?? [], error: current?.error ?? null, loadingDirs: current?.loading ?? new Set<string>(),
    isLoading: current ? current.loading.has('.') : Boolean(enabled && workspaceId), loadDirectory, refresh };
}
