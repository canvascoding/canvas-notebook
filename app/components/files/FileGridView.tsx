'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, AlertCircle, FolderOpen } from 'lucide-react';
import {
  SidebarMenu,
  SidebarGroup,
  SidebarGroupContent,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { SidebarProvider } from '@/components/ui/sidebar';
import {
  useFileStore,
  type FileNode as FileNodeType,
  type BrowserMode,
  findPathInTree,
} from '@/app/store/file-store';
import { FileTreeNode } from '@/app/components/file-browser/FileTreeNode';
import { FileContextMenu } from '@/app/components/file-browser/FileContextMenu';
import { BulkMoveDialog } from '@/app/components/file-browser/BulkMoveDialog';
import { FileGridItem } from './FileGridItem';
import type { FilesViewMode } from './FilesContainer';

function getParentDirectory(path: string) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
}

function getDirectoryDepth(path: string) {
  if (path === '.') return 0;
  return path.split('/').filter(Boolean).length;
}

function flattenDirectoryChildren(nodes: FileNodeType[], dirPath: string): FileNodeType[] | null {
  if (dirPath === '.') return nodes;
  for (const node of nodes) {
    if (node.path === dirPath) return node.children ?? null;
    if (node.children) {
      const found = flattenDirectoryChildren(node.children, dirPath);
      if (found !== null) return found;
    }
  }
  return null;
}

interface FileGridViewProps {
  viewMode: FilesViewMode;
  onPreviewImage: (path: string) => void;
}

export function FileGridView({ viewMode, onPreviewImage }: FileGridViewProps) {
  const t = useTranslations('notebook');
  const containerRef = useRef<HTMLDivElement>(null);
  const [isRestoring] = [false];

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
    searchQuery,
    expandedDirs,
    selectNode,
    loadFile,
    mobileFileOpened,
  } = useFileStore();

  const activeDirectoryChildren = flattenDirectoryChildren(fileTree, currentDirectory);

  useEffect(() => {
    let cancelled = false;

    const restoreExplorer = async () => {
      const { currentDirectory: curDir, expandedDirs: curExpanded } = useFileStore.getState();
      const hasRestorableState = curDir !== '.' || curExpanded.size > 0;

      if (!hasRestorableState) {
        await loadFileTree('.', 0);
        return;
      }

      const expandedPaths = Array.from(curExpanded).sort((a, b) => {
        const depthDiff = getDirectoryDepth(a) - getDirectoryDepth(b);
        return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
      });

      await refreshRootTree(true);
      if (cancelled) return;

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
      }
    };

    void restoreExplorer();
    return () => { cancelled = true; };
  }, [loadFileTree, loadSubdirectory, refreshRootTree]);

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
  }, [currentDirectory, selectAllInDirectory, clearMultiSelect]);

  useEffect(() => {
    if (viewMode !== 'list') return;
    if (currentDirectory === '.') return;
    const tree = useFileStore.getState().fileTree;
    let nodeExists = false;
    let hasChildren = false;
    const findNode = (nodes: FileNodeType[], path: string): boolean => {
      for (const n of nodes) {
        if (n.path === path) { nodeExists = true; hasChildren = !!(n.children && n.children.length > 0); return true; }
        if (n.children && findNode(n.children, path)) return true;
      }
      return false;
    };
    findNode(tree, currentDirectory);
    if (!nodeExists || !hasChildren) loadSubdirectory(currentDirectory, true);
  }, [viewMode, currentDirectory, loadSubdirectory]);

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
        if (node.name.toLowerCase().includes(query.toLowerCase())) return node;
        return null;
      })
      .filter((node): node is FileNodeType => node !== null);
  };

  const filteredTree = searchQuery ? filterTree(fileTree, searchQuery.toLowerCase()) : fileTree;

  const listDirChildren = viewMode === 'list'
    ? flattenDirectoryChildren(fileTree, currentDirectory)
    : null;

  const filteredListChildren = viewMode === 'list' && listDirChildren
    ? (searchQuery ? listDirChildren.filter((n: FileNodeType) => n.name.toLowerCase().includes(searchQuery.toLowerCase())) : listDirChildren)
    : null;

  if (isLoadingTree) {
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
        <Button variant="outline" size="sm" onClick={() => loadFileTree()} className="mt-2">
          {t('tryAgain')}
        </Button>
      </div>
    );
  }

  if (viewMode === 'grid') {
    const gridItems = searchQuery
      ? filteredTree
      : (activeDirectoryChildren ?? []);

    const handleOpenDirectory = async (dirPath: string) => {
      useFileStore.getState().setCurrentDirectory(dirPath);
      await loadSubdirectory(dirPath, true);
    };

    return (
      <div ref={containerRef} className="h-full overflow-y-auto p-3 md:p-4">
        {gridItems.length === 0 && !searchQuery ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
            <FolderOpen className="h-10 w-10 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">{t('noFilesFound')}</p>
            <p className="text-xs text-muted-foreground/60">{t('uploadFilesToGetStarted')}</p>
          </div>
        ) : (
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
            {gridItems.map((node) => (
              <FileGridItem
                key={node.path}
                node={node}
                onPreviewImage={onPreviewImage}
                onOpenDirectory={handleOpenDirectory}
              />
            ))}
          </div>
        )}
        {gridItems.length === 0 && searchQuery && (
          <div className="flex h-32 flex-col items-center justify-center gap-2 p-4 text-center">
            <p className="text-sm text-muted-foreground">{t('noResultsFound')}</p>
            <p className="text-xs text-muted-foreground/60">{t('noFilesMatch', { query: searchQuery })}</p>
          </div>
        )}
        <FileContextMenu />
        <BulkMoveDialog />
      </div>
    );
  }

  if (viewMode === 'list') {
    const handleNavigateInto = async (node: FileNodeType) => {
      if (node.type === 'directory') {
        useFileStore.getState().setCurrentDirectory(node.path);
        await loadSubdirectory(node.path, true);
      }
    };

    const handleNavigateUp = () => {
      if (currentDirectory === '.') return;
      const parentSegments = currentDirectory.split('/');
      parentSegments.pop();
      const parentPath = parentSegments.length === 0 ? '.' : parentSegments.join('/');
      useFileStore.getState().setCurrentDirectory(parentPath);
    };

    return (
      <SidebarProvider className="min-h-0">
        <div ref={containerRef} className="relative h-full overflow-y-auto py-2" tabIndex={-1}>
          {currentDirectory !== '.' && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              onClick={handleNavigateUp}
            >
              <span>↑ {t('goUpFolder')}</span>
            </button>
          )}
          <SidebarGroup className="p-0">
            <SidebarGroupContent>
              <SidebarMenu className="space-y-0.5">
                {filteredListChildren && filteredListChildren.length === 0 && !searchQuery && (
                  <div className="flex h-24 flex-col items-center justify-center gap-2 p-4 text-center">
                    <FolderOpen className="h-8 w-8 text-muted-foreground/50" />
                    <p className="text-sm text-muted-foreground">{t('noFilesFound')}</p>
                  </div>
                )}
                {filteredListChildren?.map((node: FileNodeType) => (
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
          {filteredListChildren && filteredListChildren.length === 0 && searchQuery && (
            <div className="flex h-32 flex-col items-center justify-center gap-2 p-4 text-center">
              <p className="text-sm text-muted-foreground">{t('noResultsFound')}</p>
              <p className="text-xs text-muted-foreground/60">{t('noFilesMatch', { query: searchQuery })}</p>
            </div>
          )}
          <FileContextMenu />
          <BulkMoveDialog />
        </div>
      </SidebarProvider>
    );
  }

  // tree view
  return (
    <SidebarProvider className="min-h-0">
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
            <p className="text-xs text-muted-foreground/60">{t('noFilesMatch', { query: searchQuery })}</p>
          </div>
        )}
        <FileContextMenu />
        <BulkMoveDialog />
      </div>
    </SidebarProvider>
  );
}
