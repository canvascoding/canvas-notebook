'use client';

import { useEffect, useMemo, useState, type RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useFileStore } from '@/app/store/file-store';
import type { FileNode as FileNodeType } from '@/app/lib/files/types';
import {
  getDirectoryDepth,
  getDirectoryPathChain,
  getParentDirectory,
} from '@/app/lib/files/path-utils';
import { findPathInTree, flattenDirectoryChildren } from '@/app/lib/files/tree-utils';

interface UseFileExplorerViewModelOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  variant: 'default' | 'mobile-sheet' | 'fullscreen';
}

interface FileSearchEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: number;
  permissions?: string;
  publicShare?: FileNodeType['publicShare'];
}

interface SearchState {
  query: string;
  results: FileNodeType[] | null;
  isSearching: boolean;
}

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
  const [isRestoring, setIsRestoring] = useState(false);
  const [searchState, setSearchState] = useState<SearchState>({
    query: '',
    results: null,
    isSearching: false,
  });

  const {
    fileTree,
    isLoadingTree,
    treeError,
    loadFileTree,
    refreshRootTree,
    loadSubdirectory,
    currentDirectory,
    selectedNode,
    selectAllInDirectory,
    clearMultiSelect,
    searchQuery,
    browserMode,
  } = useFileStore(useShallow((state) => ({
    fileTree: state.fileTree,
    isLoadingTree: state.isLoadingTree,
    treeError: state.treeError,
    loadFileTree: state.loadFileTree,
    refreshRootTree: state.refreshRootTree,
    loadSubdirectory: state.loadSubdirectory,
    currentDirectory: state.currentDirectory,
    selectedNode: state.selectedNode,
    selectAllInDirectory: state.selectAllInDirectory,
    clearMultiSelect: state.clearMultiSelect,
    searchQuery: state.searchQuery,
    browserMode: state.browserMode,
  })));

  const normalizedSearchQuery = searchQuery.trim();
  const normalizedSearchQueryLower = normalizedSearchQuery.toLowerCase();
  const searchResults = searchState.query === normalizedSearchQuery ? searchState.results : null;
  const isSearching = searchState.query === normalizedSearchQuery && searchState.isSearching;

  const activeDirectoryChildren = useMemo(
    () => browserMode === 'grid' ? flattenDirectoryChildren(fileTree, currentDirectory) : null,
    [browserMode, currentDirectory, fileTree]
  );

  useEffect(() => {
    let cancelled = false;

    const restoreExplorer = async () => {
      const {
        currentDirectory: curDir,
        expandedDirs: curExpanded,
        searchQuery: curSearch,
        selectedNode,
      } = useFileStore.getState();

      const hasRestorableState =
        selectedNode !== null ||
        curDir !== '.' ||
        curExpanded.size > 0 ||
        curSearch.trim().length > 0;

      if (!hasRestorableState) {
        await loadFileTree('.', 0);
        return;
      }

      setIsRestoring(true);

      try {
        await refreshRootTree(true);
        if (cancelled) return;

        const restorePaths = new Set<string>([
          ...Array.from(curExpanded).flatMap(getDirectoryPathChain),
          ...getDirectoryPathChain(curDir),
        ]);

        const expandedPaths = Array.from(restorePaths).sort((a, b) => {
          const depthDiff = getDirectoryDepth(a) - getDirectoryDepth(b);
          return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
        });

        const validExpandedDirs = new Set<string>();

        for (const dirPath of expandedPaths) {
          if (cancelled || dirPath === '.') continue;
          const currentTree = useFileStore.getState().fileTree;
          const parentDir = getParentDirectory(dirPath);
          const parentExists = parentDir === '.'
            ? currentTree.some((node) => node.type === 'directory' && node.path === dirPath.split('/')[0])
            : findPathInTree(parentDir, currentTree);
          if (!parentExists) continue;
          await loadSubdirectory(dirPath, true);
          if (cancelled) return;

          const nextTree = useFileStore.getState().fileTree;
          if (curExpanded.has(dirPath) && findPathInTree(dirPath, nextTree)) {
            validExpandedDirs.add(dirPath);
          }
        }

        const restoredTree = useFileStore.getState().fileTree;
        const currentExpanded = useFileStore.getState().expandedDirs;
        useFileStore.getState().setExpandedDirs(
          new Set(
            Array.from(currentExpanded).filter((dirPath) => (
              dirPath === '.' ||
              validExpandedDirs.has(dirPath) ||
              findPathInTree(dirPath, restoredTree)
            ))
          )
        );

        const latestState = useFileStore.getState();
        const latestDir = latestState.currentDirectory;
        const latestSelectedNode = latestState.selectedNode;
        const currentDirExists = latestDir === '.' || findPathInTree(latestDir, restoredTree);

        if (!currentDirExists) {
          const fallbackDir = latestSelectedNode?.type === 'directory'
            ? latestSelectedNode.path
            : latestSelectedNode?.path
              ? getParentDirectory(latestSelectedNode.path)
              : '.';
          useFileStore.getState().setCurrentDirectory(
            fallbackDir !== '.' && findPathInTree(fallbackDir, restoredTree) ? fallbackDir : '.'
          );
        }
      } finally {
        if (!cancelled) {
          setIsRestoring(false);
        }
      }
    };

    void restoreExplorer();
    return () => { cancelled = true; };
  }, [loadFileTree, loadSubdirectory, refreshRootTree, variant]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!containerRef.current?.contains(document.activeElement)) return;
      if ((event.ctrlKey || event.metaKey) && event.key === 'a') {
        event.preventDefault();
        selectAllInDirectory(currentDirectory);
      }
      if (event.key === 'Escape') {
        clearMultiSelect();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [clearMultiSelect, containerRef, currentDirectory, selectAllInDirectory]);

  useEffect(() => {
    if (browserMode !== 'grid') return;
    if (currentDirectory === '.') return;
    if (activeDirectoryChildren !== null) return;
    void loadSubdirectory(currentDirectory, true);
  }, [activeDirectoryChildren, browserMode, currentDirectory, loadSubdirectory]);

  useEffect(() => {
    if (browserMode !== 'list') return;
    if (currentDirectory === '.') return;
    const { exists, isLoaded } = directoryLoadState(useFileStore.getState().fileTree, currentDirectory);
    if (!exists || !isLoaded) loadSubdirectory(currentDirectory, true);
  }, [browserMode, currentDirectory, loadSubdirectory]);

  useEffect(() => {
    const query = normalizedSearchQuery;
    if (!query) {
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setSearchState({ query, results: null, isSearching: true });
      try {
        const response = await fetch(`/api/files/list?q=${encodeURIComponent(query)}&limit=200`, {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error('Failed to search files');
        }

        const payload = await response.json() as { files?: FileSearchEntry[] };
        const nextResults = (payload.files ?? []).map((entry) => ({
          name: entry.name,
          path: entry.path,
          type: entry.type,
          size: entry.size,
          modified: entry.modified,
          permissions: entry.permissions,
          publicShare: entry.publicShare,
        } satisfies FileNodeType));
        if (controller.signal.aborted) return;
        setSearchState({ query, results: nextResults, isSearching: false });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setSearchState({ query, results: [], isSearching: false });
        }
      }
    }, 200);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [normalizedSearchQuery]);

  const filteredTree = useMemo(
    () => normalizedSearchQuery ? filterTree(fileTree, normalizedSearchQueryLower) : fileTree,
    [fileTree, normalizedSearchQuery, normalizedSearchQueryLower]
  );

  const searchResultNodes = useMemo(
    () => normalizedSearchQuery ? (searchResults ?? filteredTree) : filteredTree,
    [filteredTree, normalizedSearchQuery, searchResults]
  );

  const listDirectoryChildren = useMemo(
    () => browserMode === 'list'
      ? flattenDirectoryChildren(fileTree, currentDirectory)
      : null,
    [browserMode, currentDirectory, fileTree]
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

  const listSelectionOrder = useMemo(
    () => filteredListChildren?.map((node) => node.path) ?? [],
    [filteredListChildren]
  );

  useEffect(() => {
    if (!selectedNode || isRestoring || isLoadingTree) return;

    const frame = window.requestAnimationFrame(() => {
      const activeItem = Array.from(containerRef.current?.querySelectorAll<HTMLElement>('[data-file-path]') ?? [])
        .find((element) => element.dataset.filePath === selectedNode.path);
      activeItem?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [browserMode, containerRef, currentDirectory, fileTree, filteredListChildren, isLoadingTree, isRestoring, searchResultNodes, selectedNode]);

  return {
    browserMode,
    currentDirectory,
    fileTree,
    filteredListChildren,
    gridItems,
    gridSelectionOrder,
    isLoadingTree,
    isRestoring,
    isSearching,
    listSelectionOrder,
    loadFileTree,
    loadSubdirectory,
    normalizedSearchQuery,
    searchQuery,
    searchResultNodes,
    treeError,
  };
}
