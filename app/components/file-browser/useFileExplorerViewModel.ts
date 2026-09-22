'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useFileStore } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import type { FileNode as FileNodeType } from '@/app/lib/files/types';
import {
  getDirectoryDepth,
  getDirectoryPathChain,
  getParentDirectory,
} from '@/app/lib/files/path-utils';
import { runDirectoryTasksByDepth } from '@/app/lib/files/tree-refresh';
import { findPathInTree, flattenDirectoryChildren } from '@/app/lib/files/tree-utils';
import { searchWorkspaceFileReferences } from '@/app/lib/files/client';
import { sortFileNodes, sortFileTree } from '@/app/lib/files/sort';
import { useExplorerScrollAnchor } from './useExplorerScrollAnchor';

interface UseFileExplorerViewModelOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  variant: 'default' | 'mobile-sheet' | 'fullscreen';
}

interface SearchState {
  workspaceId: string | null;
  query: string;
  results: FileNodeType[] | null;
  total: number | null;
  isSearching: boolean;
  error: string | null;
}

const RESTORE_LOAD_CONCURRENCY = 4;
const SEARCH_RESULT_LIMIT = 200;
const EMPTY_FILE_TREE: FileNodeType[] = [];

function filterTree(nodes: FileNodeType[], query: string): FileNodeType[] {
  if (!query) return nodes;
  return nodes
    .map((node) => {
      if (node.type === 'directory' && node.children) {
        const filteredChildren = filterTree(node.children, query);
        if (filteredChildren.length > 0 || node.name.toLowerCase().includes(query)) {
          return { ...node, children: filteredChildren };
        }
        return null;
      }
      if (node.name.toLowerCase().includes(query)) return node;
      return null;
    })
    .filter((node): node is FileNodeType => node !== null);
}

function directoryLoadState(nodes: FileNodeType[], path: string): { exists: boolean; isLoaded: boolean } {
  for (const node of nodes) {
    if (node.path === path) {
      return { exists: true, isLoaded: Array.isArray(node.children) };
    }
    if (node.children) {
      const found = directoryLoadState(node.children, path);
      if (found.exists) return found;
    }
  }
  return { exists: false, isLoaded: false };
}

export function useFileExplorerViewModel({ containerRef, variant }: UseFileExplorerViewModelOptions) {
  const lastScrolledSelection = useRef<string | null>(null);
  const [restoringScope, setRestoringScope] = useState<string | null>(null);
  const [loadedRootScope, setLoadedRootScope] = useState<string | null>(null);
  const [searchState, setSearchState] = useState<SearchState>({
    workspaceId: null,
    query: '',
    results: null,
    total: null,
    isSearching: false,
    error: null,
  });

  const {
    fileTree: storedFileTree,
    fileTreeWorkspaceId,
    treeGeneration,
    rootLoadState,
    isLoadingTree,
    treeError: storedTreeError,
    loadFileTree,
    refreshRootTree,
    loadSubdirectory,
    resetWorkspaceView,
    hydrateClientPreferences,
    currentDirectory,
    selectedNode,
    browserReveal,
    workspaceFileVersion,
    selectAllInDirectory,
    setMultiSelectPaths,
    clearMultiSelect,
    searchQuery,
    browserMode,
    fileSortKey,
    fileSortDirection,
    setFileSort,
  } = useFileStore(useShallow((state) => ({
    fileTree: state.fileTree,
    fileTreeWorkspaceId: state.fileTreeWorkspaceId,
    treeGeneration: state.treeGeneration,
    rootLoadState: state.directoryLoadStates['.'],
    isLoadingTree: state.isLoadingTree,
    treeError: state.treeError,
    loadFileTree: state.loadFileTree,
    refreshRootTree: state.refreshRootTree,
    loadSubdirectory: state.loadSubdirectory,
    resetWorkspaceView: state.resetWorkspaceView,
    hydrateClientPreferences: state.hydrateClientPreferences,
    currentDirectory: state.currentDirectory,
    selectedNode: state.selectedNode,
    browserReveal: state.browserReveal,
    workspaceFileVersion: state.workspaceFileVersion,
    selectAllInDirectory: state.selectAllInDirectory,
    setMultiSelectPaths: state.setMultiSelectPaths,
    clearMultiSelect: state.clearMultiSelect,
    searchQuery: state.searchQuery,
    browserMode: state.browserMode,
    fileSortKey: state.fileSortKey,
    fileSortDirection: state.fileSortDirection,
    setFileSort: state.setFileSort,
  })));
  const { activeWorkspaceId, workspaceInitialized } = useWorkspaceStore(useShallow((state) => ({
    activeWorkspaceId: state.activeWorkspaceId,
    workspaceInitialized: state.initialized,
  })));
  const workspaceReady = workspaceInitialized && Boolean(activeWorkspaceId);
  const ownsTree = workspaceReady && fileTreeWorkspaceId === activeWorkspaceId;
  const fileTree = ownsTree ? storedFileTree : EMPTY_FILE_TREE;
  const treeError = ownsTree ? storedTreeError : null;
  const rootScope = JSON.stringify([activeWorkspaceId, treeGeneration]);
  const isRestoring = restoringScope === rootScope;
  const hasTreeSnapshot = ownsTree && (fileTree.length > 0 || rootLoadState === 'ready'
    || rootLoadState === 'refreshing' || loadedRootScope === rootScope);
  const isInitialTreeLoading = !workspaceReady || !ownsTree || (!hasTreeSnapshot && !treeError);
  const isRefreshingTree = hasTreeSnapshot && (isLoadingTree || isRestoring || rootLoadState === 'refreshing');

  const normalizedSearchQuery = searchQuery.trim();
  const normalizedSearchQueryLower = normalizedSearchQuery.toLowerCase();
  const searchResults = searchState.workspaceId === activeWorkspaceId && searchState.query === normalizedSearchQuery ? searchState.results : null;
  const searchResultTotal = searchState.workspaceId === activeWorkspaceId && searchState.query === normalizedSearchQuery ? searchState.total : null;
  const isSearching = searchState.workspaceId === activeWorkspaceId && searchState.query === normalizedSearchQuery && searchState.isSearching;
  const searchError = searchState.workspaceId === activeWorkspaceId && searchState.query === normalizedSearchQuery ? searchState.error : null;

  const activeDirectoryChildren = useMemo(
    () => {
      if (browserMode !== 'grid') return null;
      const children = flattenDirectoryChildren(fileTree, currentDirectory);
      return children ? sortFileNodes(children, fileSortKey, fileSortDirection) : null;
    },
    [browserMode, currentDirectory, fileSortDirection, fileSortKey, fileTree]
  );

  useEffect(() => {
    if (!workspaceReady || !activeWorkspaceId) return;
    let cancelled = false;
    let generation: number | null = null;
    const isCurrent = () => !cancelled
      && useWorkspaceStore.getState().activeWorkspaceId === activeWorkspaceId
      && useWorkspaceStore.getState().initialized
      && (generation === null || (useFileStore.getState().treeGeneration === generation
        && useFileStore.getState().fileTreeWorkspaceId === activeWorkspaceId));

    const restoreExplorer = async () => {
      const initialState = useFileStore.getState();
      const workspaceChanged = initialState.fileTreeWorkspaceId !== activeWorkspaceId;
      if (workspaceChanged) resetWorkspaceView(activeWorkspaceId);
      if (!isCurrent()) return;
      generation = useFileStore.getState().treeGeneration;
      const scope = JSON.stringify([activeWorkspaceId, generation]);
      hydrateClientPreferences(activeWorkspaceId, workspaceChanged);
      if (!isCurrent()) return;
      const { currentDirectory: curDir, expandedDirs: curExpanded, searchQuery: curSearch, selectedNode } = useFileStore.getState();
      const hasRestorableState = selectedNode !== null || curDir !== '.' || curExpanded.size > 0 || curSearch.trim().length > 0;
      const previousRoot = useFileStore.getState();
      if (previousRoot.fileTree.length > 0 || previousRoot.directoryLoadStates['.'] === 'ready'
        || previousRoot.directoryLoadStates['.'] === 'refreshing') setLoadedRootScope(scope);
      setRestoringScope(scope);
      try {
        if (hasRestorableState) await refreshRootTree(true, activeWorkspaceId);
        else await loadFileTree('.', 0, false, activeWorkspaceId);
        if (!isCurrent()) return;
        if (useFileStore.getState().directoryLoadStates['.'] === 'ready') setLoadedRootScope(scope);
        if (!hasRestorableState || useFileStore.getState().treeError) return;

        const restorePaths = new Set<string>([
          ...Array.from(curExpanded).flatMap(getDirectoryPathChain), ...getDirectoryPathChain(curDir),
        ]);
        const validExpandedDirs = new Set<string>();
        await runDirectoryTasksByDepth(
          Array.from(restorePaths).sort((a, b) => {
            const depthDiff = getDirectoryDepth(a) - getDirectoryDepth(b);
            return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
          }),
          async (dirPath) => {
            if (!isCurrent()) return;
            const currentTree = useFileStore.getState().fileTree;
            const parentDir = getParentDirectory(dirPath);
            const parentExists = parentDir === '.'
              ? currentTree.some((node) => node.type === 'directory' && node.path === dirPath.split('/')[0])
              : findPathInTree(parentDir, currentTree);
            if (!parentExists) return;
            await loadSubdirectory(dirPath, true, true, activeWorkspaceId);
            if (!isCurrent()) return;
            if (curExpanded.has(dirPath) && findPathInTree(dirPath, useFileStore.getState().fileTree)) validExpandedDirs.add(dirPath);
          },
          { concurrency: RESTORE_LOAD_CONCURRENCY, includeRoot: false },
        );
        if (!isCurrent()) return;
        const restoredTree = useFileStore.getState().fileTree;
        const currentExpanded = useFileStore.getState().expandedDirs;
        useFileStore.getState().setExpandedDirs(new Set(Array.from(currentExpanded).filter((dirPath) => (
          dirPath === '.' || validExpandedDirs.has(dirPath) || findPathInTree(dirPath, restoredTree)
        ))));
        if (!isCurrent()) return;
        const latestState = useFileStore.getState();
        const latestDir = latestState.currentDirectory;
        const latestSelectedNode = latestState.selectedNode;
        if (latestDir !== '.' && !findPathInTree(latestDir, restoredTree)) {
          const fallbackDir = latestSelectedNode?.type === 'directory' ? latestSelectedNode.path
            : latestSelectedNode?.path ? getParentDirectory(latestSelectedNode.path) : '.';
          useFileStore.getState().setCurrentDirectory(fallbackDir !== '.' && findPathInTree(fallbackDir, restoredTree) ? fallbackDir : '.');
        }
      } catch (error) {
        if (isCurrent()) console.error('Failed to restore file explorer', error);
      } finally {
        if (isCurrent()) setRestoringScope(null);
      }
    };
    void restoreExplorer();
    return () => { cancelled = true; };
  }, [activeWorkspaceId, hydrateClientPreferences, loadFileTree, loadSubdirectory, refreshRootTree, resetWorkspaceView, treeGeneration, variant, workspaceReady]);

  useEffect(() => {
    if (!workspaceReady || !ownsTree || !activeWorkspaceId || browserMode !== 'grid') return;
    if (currentDirectory === '.') return;
    if (activeDirectoryChildren !== null) return;
    void loadSubdirectory(currentDirectory, true, false, activeWorkspaceId);
  }, [activeDirectoryChildren, activeWorkspaceId, browserMode, currentDirectory, loadSubdirectory, ownsTree, workspaceReady]);

  useEffect(() => {
    if (!workspaceReady || !ownsTree || !activeWorkspaceId || browserMode !== 'list') return;
    if (currentDirectory === '.') return;
    const { exists, isLoaded } = directoryLoadState(useFileStore.getState().fileTree, currentDirectory);
    if (!exists || !isLoaded) void loadSubdirectory(currentDirectory, true, false, activeWorkspaceId);
  }, [activeWorkspaceId, browserMode, currentDirectory, loadSubdirectory, ownsTree, workspaceReady]);

  useEffect(() => {
    const query = normalizedSearchQuery;
    if (!query || !workspaceReady || !activeWorkspaceId) return;

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setSearchState((previous) => previous.workspaceId === activeWorkspaceId && previous.query === query ? { ...previous, isSearching: true, error: null }
        : { workspaceId: activeWorkspaceId, query, results: null, total: null, isSearching: true, error: null });
      try {
        if (!activeWorkspaceId) throw new Error('Workspace context is not ready');
        const result = await searchWorkspaceFileReferences({
          query,
          limit: SEARCH_RESULT_LIMIT,
          workspaceId: activeWorkspaceId,
          signal: controller.signal,
        });
        const nextResults = result.files.map((entry) => ({
          name: entry.name,
          path: entry.path,
          type: entry.type,
          size: entry.size,
          publicShare: entry.publicShare,
        } satisfies FileNodeType));
        if (controller.signal.aborted) return;
        setSearchState({ workspaceId: activeWorkspaceId, query, results: nextResults, total: result.total, isSearching: false, error: null });
      } catch (error) {
        if (!controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
          setSearchState((previous) => ({
            workspaceId: activeWorkspaceId,
            query,
            results: previous.workspaceId === activeWorkspaceId && previous.query === query ? previous.results : null,
            total: previous.workspaceId === activeWorkspaceId && previous.query === query ? previous.total : null,
            isSearching: false,
            error: error instanceof Error ? error.message : 'Failed to search files',
          }));
        }
      }
    }, 200);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [activeWorkspaceId, normalizedSearchQuery, workspaceFileVersion, workspaceReady]);

  const filteredTree = useMemo(
    () => sortFileTree(
      normalizedSearchQuery ? filterTree(fileTree, normalizedSearchQueryLower) : fileTree,
      fileSortKey,
      fileSortDirection,
    ),
    [fileSortDirection, fileSortKey, fileTree, normalizedSearchQuery, normalizedSearchQueryLower]
  );

  const searchResultNodes = useMemo(
    () => normalizedSearchQuery && searchResults
      ? sortFileNodes(searchResults, fileSortKey, fileSortDirection)
      : filteredTree,
    [fileSortDirection, fileSortKey, filteredTree, normalizedSearchQuery, searchResults]
  );

  const listDirectoryChildren = useMemo(
    () => browserMode === 'list'
      ? (() => {
          const children = flattenDirectoryChildren(fileTree, currentDirectory);
          return children ? sortFileNodes(children, fileSortKey, fileSortDirection) : null;
        })()
      : null,
    [browserMode, currentDirectory, fileSortDirection, fileSortKey, fileTree]
  );

  const filteredListChildren = useMemo(
    () => normalizedSearchQuery
      ? searchResultNodes
      : browserMode === 'list' && listDirectoryChildren
        ? listDirectoryChildren
        : null,
    [browserMode, listDirectoryChildren, normalizedSearchQuery, searchResultNodes]
  );

  const gridItems = useMemo(
    () => normalizedSearchQuery
      ? searchResultNodes
      : (activeDirectoryChildren ?? []),
    [activeDirectoryChildren, normalizedSearchQuery, searchResultNodes]
  );

  const gridSelectionOrder = useMemo(
    () => gridItems.map((node) => node.path),
    [gridItems]
  );

  const visibleSearchResultCount = normalizedSearchQuery ? searchResultNodes.length : 0;

  const listSelectionOrder = useMemo(
    () => filteredListChildren?.map((node) => node.path) ?? [],
    [filteredListChildren]
  );

  const treeSelectionOrder = useMemo(
    () => searchResultNodes.map((node) => node.path),
    [searchResultNodes]
  );

  const visibleSelectionPaths = useMemo(() => {
    if (normalizedSearchQuery) return searchResults?.map((node) => node.path) ?? [];
    if (browserMode === 'grid') return gridItems.map((node) => node.path);
    if (browserMode === 'list') return filteredListChildren?.map((node) => node.path) ?? [];
    return null;
  }, [browserMode, filteredListChildren, gridItems, normalizedSearchQuery, searchResults]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!containerRef.current?.contains(document.activeElement)) return;
      const target = event.target;
      const isTextInput = (typeof HTMLInputElement !== 'undefined' && target instanceof HTMLInputElement)
        || (typeof HTMLTextAreaElement !== 'undefined' && target instanceof HTMLTextAreaElement)
        || (target instanceof HTMLElement && target.isContentEditable);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !isTextInput) {
        event.preventDefault();
        if (visibleSelectionPaths !== null) {
          setMultiSelectPaths(visibleSelectionPaths, true);
        } else {
          selectAllInDirectory(currentDirectory);
        }
      }
      if (event.key === 'Escape') {
        clearMultiSelect();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [clearMultiSelect, containerRef, currentDirectory, selectAllInDirectory, setMultiSelectPaths, visibleSelectionPaths]);

  useExplorerScrollAnchor(containerRef, `${activeWorkspaceId}\0${browserMode}\0${currentDirectory}\0${normalizedSearchQuery}`, searchResultNodes);

  useEffect(() => {
    if (!selectedNode) { lastScrolledSelection.current = null; return; }
    if (isRestoring || isLoadingTree) return;
    const selection = `${activeWorkspaceId}\0${browserMode}\0${currentDirectory}\0${selectedNode.path}`;
    const needsReveal = browserReveal?.status === 'ready' && browserReveal.path === selectedNode.path
      && browserReveal.workspaceId === activeWorkspaceId;
    if (!needsReveal && lastScrolledSelection.current === selection) return;

    const frame = window.requestAnimationFrame(() => {
      const activeItem = Array.from(containerRef.current?.querySelectorAll<HTMLElement>('[data-file-path]') ?? [])
        .find((element) => element.dataset.filePath === selectedNode.path);
      if (activeItem) {
        lastScrolledSelection.current = selection;
        activeItem.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      const pending = useFileStore.getState().browserReveal;
      if (activeItem && pending?.status === 'ready' && pending.path === selectedNode.path
        && pending.workspaceId === useWorkspaceStore.getState().activeWorkspaceId) {
        useFileStore.setState({ browserReveal: { ...pending, status: 'visible' } });
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [activeWorkspaceId, browserMode, browserReveal, containerRef, currentDirectory, fileTree, filteredListChildren, isLoadingTree, isRestoring, searchResultNodes, selectedNode]);

  return {
    browserMode,
    currentDirectory,
    fileTree,
    fileSortDirection,
    fileSortKey,
    filteredListChildren,
    gridItems,
    gridSelectionOrder,
    isLoadingTree,
    isRestoring,
    hasTreeSnapshot,
    isInitialTreeLoading,
    isRefreshingTree,
    isSearching,
    listSelectionOrder,
    loadFileTree,
    loadSubdirectory,
    normalizedSearchQuery,
    searchQuery,
    searchError,
    searchResultTotal,
    visibleSearchResultCount,
    searchResultNodes,
    setFileSort,
    treeError,
    treeSelectionOrder,
  };
}
