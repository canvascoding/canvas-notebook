'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, AlertCircle, FolderOpen, ArrowUp } from 'lucide-react';
import {
  SidebarMenu,
  SidebarGroup,
  SidebarGroupContent,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { useFileStore, FileNode as FileNodeType, findPathInTree, type BrowserMode } from '@/app/store/file-store';
import { FileTreeNode } from './FileTreeNode';
import { FileContextMenu } from './FileContextMenu';
import { BulkMoveDialog } from './BulkMoveDialog';

interface FileTreeProps {
  variant?: 'default' | 'mobile-sheet';
  browserMode?: BrowserMode;
}

function getParentDirectory(path: string) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
}

function getDirectoryDepth(path: string) {
  if (path === '.') return 0;
  return path.split('/').filter(Boolean).length;
}

export function FileTree({ variant = 'default', browserMode = 'tree' }: FileTreeProps) {
  const t = useTranslations('notebook');
  const containerRef = useRef<HTMLDivElement>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const {
    fileTree,
    isLoadingTree,
    treeError,
    loadFileTree,
    refreshRootTree,
    loadSubdirectory,
    currentDirectory,
    selectAllInDirectory,
    clearMultiSelect,
  } = useFileStore();

  useEffect(() => {
    let cancelled = false;

    const restoreMobileExplorer = async () => {
      const {
        selectedNode,
        currentDirectory: currentDir,
        expandedDirs,
        searchQuery,
      } = useFileStore.getState();

      const hasRestorableState =
        selectedNode !== null ||
        currentDir !== '.' ||
        expandedDirs.size > 0 ||
        searchQuery.trim().length > 0;

      if (variant !== 'mobile-sheet' || !hasRestorableState) {
        await loadFileTree('.', 0);
        return;
      }

      setIsRestoring(true);

      try {
        await refreshRootTree(true);
        if (cancelled) return;

        const expandedPaths = Array.from(expandedDirs).sort((a, b) => {
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

          if (!parentExists) {
            continue;
          }

          await loadSubdirectory(dirPath, true);
          if (cancelled) return;

          const nextTree = useFileStore.getState().fileTree;
          if (findPathInTree(dirPath, nextTree)) {
            validExpandedDirs.add(dirPath);
          }
        }

        useFileStore.setState((state) => ({
          expandedDirs: new Set(
            Array.from(state.expandedDirs).filter((dirPath) => dirPath === '.' || validExpandedDirs.has(dirPath))
          ),
        }));

        const restoredTree = useFileStore.getState().fileTree;
        const currentDirExists = currentDir === '.'
          ? true
          : findPathInTree(currentDir, restoredTree);

        if (!currentDirExists) {
          const fallbackDir = selectedNode?.type === 'directory'
            ? selectedNode.path
            : selectedNode?.path
              ? getParentDirectory(selectedNode.path)
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

    void restoreMobileExplorer();

    return () => {
      cancelled = true;
    };
  }, [
    loadFileTree,
    loadSubdirectory,
    refreshRootTree,
    variant,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Only handle shortcuts when focus is within the file tree
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
  }, [currentDirectory, selectAllInDirectory, clearMultiSelect]);

  useEffect(() => {
    if (browserMode !== 'list') return;
    if (currentDirectory === '.') return;
    const tree = useFileStore.getState().fileTree;
    let nodeExists = false;
    let hasChildren = false;
    const findNode = (nodes: FileNodeType[], path: string): boolean => {
      for (const n of nodes) {
        if (n.path === path) {
          nodeExists = true;
          hasChildren = !!(n.children && n.children.length > 0);
          return true;
        }
        if (n.children && findNode(n.children, path)) return true;
      }
      return false;
    };
    findNode(tree, currentDirectory);
    if (!nodeExists || !hasChildren) {
      loadSubdirectory(currentDirectory, true);
    }
  }, [browserMode, currentDirectory, loadSubdirectory]);

  // Filter tree based on search query
  const filterTree = (nodes: FileNodeType[], query: string): FileNodeType[] => {
    if (!query) return nodes;
    
    return nodes
      .map((node) => {
        if (node.type === 'directory' && node.children) {
          const filteredChildren = filterTree(node.children, query);
          if (filteredChildren.length > 0 || node.name.toLowerCase().includes(query.toLowerCase())) {
            return { ...node, children: filteredChildren };
          }
          return null;
        }
        if (node.name.toLowerCase().includes(query.toLowerCase())) {
          return node;
        }
        return null;
      })
      .filter((node): node is FileNodeType => node !== null);
  };

  const findChildrenForDirectory = (dirPath: string, nodes: FileNodeType[]): FileNodeType[] | null => {
    if (dirPath === '.') return nodes;
    for (const node of nodes) {
      if (node.path === dirPath) return node.children ?? null;
      if (node.children) {
        const found = findChildrenForDirectory(dirPath, node.children);
        if (found !== null) return found;
      }
    }
    return null;
  };

  const listDirChildren = browserMode === 'list'
    ? (findChildrenForDirectory(currentDirectory, fileTree) ?? [])
    : null;

  const handleNavigateUp = useCallback(() => {
    if (currentDirectory === '.') return;
    const parentSegments = currentDirectory.split('/');
    parentSegments.pop();
    const parentPath = parentSegments.length === 0 ? '.' : parentSegments.join('/');
    useFileStore.getState().setCurrentDirectory(parentPath);
  }, [currentDirectory]);

  const handleNavigateInto = useCallback(
    async (node: FileNodeType) => {
      if (node.type === 'directory') {
        useFileStore.getState().setCurrentDirectory(node.path);
        await loadSubdirectory(node.path, true);
      }
    },
    [loadSubdirectory]
  );

  const { searchQuery } = useFileStore();
  const filteredTree = searchQuery
    ? filterTree(fileTree, searchQuery.toLowerCase())
    : fileTree;

  if (isLoadingTree || isRestoring) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (treeError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-muted-foreground">{treeError}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => loadFileTree()}
          className="mt-2"
        >
          {t('tryAgain')}
        </Button>
      </div>
    );
  }

  if (fileTree.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <FolderOpen className="h-10 w-10 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">{t('noFilesFound')}</p>
        <p className="text-xs text-muted-foreground/60">{t('uploadFilesToGetStarted')}</p>
      </div>
    );
  }

  if (browserMode === 'list' && listDirChildren) {
    const filteredChildren = searchQuery
      ? listDirChildren.filter((n) => n.name.toLowerCase().includes(searchQuery.toLowerCase()))
      : listDirChildren;

    return (
      <div ref={containerRef} className="relative h-full overflow-y-auto py-2" tabIndex={-1}>
        {currentDirectory !== '.' && (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            onClick={handleNavigateUp}
          >
            <ArrowUp className="h-4 w-4 shrink-0" />
            <span>{t('goUpFolder')}</span>
          </button>
        )}
        <SidebarGroup className="p-0">
          <SidebarGroupContent>
            <SidebarMenu className="space-y-0.5">
              {filteredChildren.length === 0 && !searchQuery && (
                <div className="flex h-24 flex-col items-center justify-center gap-2 p-4 text-center">
                  <FolderOpen className="h-8 w-8 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">{t('noFilesFound')}</p>
                </div>
              )}
              {filteredChildren.map((node) => (
                <FileTreeNode
                  key={node.path}
                  node={node}
                  browserMode="list"
                  onNavigateInto={handleNavigateInto}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {filteredChildren.length === 0 && searchQuery && (
          <div className="flex h-32 flex-col items-center justify-center gap-2 p-4 text-center">
            <p className="text-sm text-muted-foreground">{t('noResultsFound')}</p>
            <p className="text-xs text-muted-foreground/60">
              {t('noFilesMatch', { query: searchQuery })}
            </p>
          </div>
        )}

        <BulkMoveDialog />
        <FileContextMenu />
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative h-full overflow-y-auto py-2" tabIndex={-1}>
      <SidebarGroup className="p-0">
        <SidebarGroupContent>
          <SidebarMenu className="space-y-0.5">
            {filteredTree.map((node) => (
              <FileTreeNode key={node.path} node={node} />
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
      
      {filteredTree.length === 0 && searchQuery && (
        <div className="flex h-32 flex-col items-center justify-center gap-2 p-4 text-center">
          <p className="text-sm text-muted-foreground">{t('noResultsFound')}</p>
          <p className="text-xs text-muted-foreground/60">
            {t('noFilesMatch', { query: searchQuery })}
          </p>
        </div>
      )}

      <BulkMoveDialog />
      <FileContextMenu />
    </div>
  );
}
