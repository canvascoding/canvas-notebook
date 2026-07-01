'use client';

import { useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, AlertCircle, FolderOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  SidebarMenu,
  SidebarGroup,
  SidebarGroupContent,
  SidebarProvider,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { useFileStore } from '@/app/store/file-store';
import type { FileNode as FileNodeType } from '@/app/lib/files/types';
import { FileTreeNode } from './FileTreeNode';
import { FileContextMenu } from './FileContextMenu';
import { BulkMoveDialog } from './BulkMoveDialog';
import { FileGridItem } from './FileGridItem';
import { BackgroundContextMenu } from './BackgroundContextMenu';
import { useFileExplorerViewModel } from './useFileExplorerViewModel';

interface FileGridViewProps {
  variant?: 'default' | 'mobile-sheet' | 'fullscreen';
  onOpenFile?: (path: string) => void;
}

export function FileGridView({ variant = 'default', onOpenFile }: FileGridViewProps) {
  const t = useTranslations('notebook');
  const containerRef = useRef<HTMLDivElement>(null);
  const {
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
  } = useFileExplorerViewModel({ containerRef, variant });

  const handleFileOpen = useCallback((path: string) => {
    if (onOpenFile) {
      onOpenFile(path);
    } else {
      void useFileStore.getState().loadFile(path, true);
    }
  }, [onOpenFile]);

  const handleBackgroundContextMenu = useCallback((event: React.MouseEvent) => {
    // Nur wenn nicht auf ein FileGridItem geklickt wurde
    const target = event.target as HTMLElement;
    if (target.closest('[data-file-path]') || target.closest('[role="menuitem"]')) return;
    event.preventDefault();
    event.stopPropagation();
    useFileStore.getState().openBackgroundContextMenu(
      { x: event.clientX, y: event.clientY },
      currentDirectory
    );
  }, [currentDirectory]);

  const handleOpenDirectory = useCallback(async (dirPath: string) => {
    useFileStore.getState().setCurrentDirectory(dirPath);
    await loadSubdirectory(dirPath, true);
  }, [loadSubdirectory]);

  const handleNavigateInto = useCallback(async (node: FileNodeType) => {
    if (node.type === 'directory') {
      useFileStore.getState().setCurrentDirectory(node.path);
      await loadSubdirectory(node.path, true);
    }
  }, [loadSubdirectory]);

  const handleNavigateUp = useCallback(() => {
    if (currentDirectory === '.') return;
    const parentSegments = currentDirectory.split('/');
    parentSegments.pop();
    const parentPath = parentSegments.length === 0 ? '.' : parentSegments.join('/');
    useFileStore.getState().setCurrentDirectory(parentPath);
  }, [currentDirectory]);

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
        <Button variant="outline" size="sm" onClick={() => loadFileTree()} className="mt-2">
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

  if (browserMode === 'grid') {
    return (
      <div ref={containerRef} className="h-full overflow-y-auto p-3 md:p-4" onContextMenu={handleBackgroundContextMenu}>
        {gridItems.length === 0 && !searchQuery ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
            <FolderOpen className="h-10 w-10 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">{t('noFilesFound')}</p>
            <p className="text-xs text-muted-foreground/60">{t('uploadFilesToGetStarted')}</p>
          </div>
        ) : (
          <div
            className={cn('grid gap-3', variant === 'fullscreen' && 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8')}
            style={variant !== 'fullscreen' ? { gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' } : undefined}
          >
            {gridItems.map((node) => (
              <FileGridItem
                key={node.path}
                node={node}
                onOpenFile={handleFileOpen}
                onOpenDirectory={handleOpenDirectory}
                size={variant === 'fullscreen' ? 'lg' : 'sm'}
                selectionOrder={gridSelectionOrder}
              />
            ))}
          </div>
        )}
        {isSearching && normalizedSearchQuery && (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {!isSearching && gridItems.length === 0 && normalizedSearchQuery && (
          <div className="flex h-32 flex-col items-center justify-center gap-2 p-4 text-center">
            <p className="text-sm text-muted-foreground">{t('noResultsFound')}</p>
            <p className="text-xs text-muted-foreground/60">{t('noFilesMatch', { query: searchQuery })}</p>
          </div>
        )}
        <FileContextMenu />
        <BackgroundContextMenu />
        <BulkMoveDialog />
      </div>
    );
  }

  if (browserMode === 'list') {
    const listContent = (
      <div ref={containerRef} className="relative h-full overflow-y-auto py-2" tabIndex={-1} onContextMenu={handleBackgroundContextMenu}>
        {currentDirectory !== '.' && (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            onClick={handleNavigateUp}
          >
            <span>↑ {t('goUpFolder')}</span>
          </button>
        )}
        <SidebarProvider>
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
                    onOpenFile={handleFileOpen}
                    selectionOrder={listSelectionOrder}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarProvider>
        {isSearching && normalizedSearchQuery && (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {!isSearching && filteredListChildren && filteredListChildren.length === 0 && normalizedSearchQuery && (
          <div className="flex h-32 flex-col items-center justify-center gap-2 p-4 text-center">
            <p className="text-sm text-muted-foreground">{t('noResultsFound')}</p>
            <p className="text-xs text-muted-foreground/60">{t('noFilesMatch', { query: searchQuery })}</p>
          </div>
        )}
        <FileContextMenu />
        <BackgroundContextMenu />
        <BulkMoveDialog />
      </div>
    );

    if (variant === 'fullscreen') {
      return (
        <div className="h-full w-full max-w-5xl mx-auto">{listContent}</div>
      );
    }

    return listContent;
  }

  // tree view
  const treeContent = (
    <div ref={containerRef} className="relative h-full overflow-y-auto py-2" tabIndex={-1} onContextMenu={handleBackgroundContextMenu}>
      <SidebarProvider>
        <SidebarGroup className="p-0">
          <SidebarGroupContent>
            <SidebarMenu className="space-y-0.5">
              {searchResultNodes.map((node) => (
                <FileTreeNode key={node.path} node={node} onOpenFile={handleFileOpen} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarProvider>
      {isSearching && normalizedSearchQuery && (
        <div className="flex h-24 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}
      {!isSearching && searchResultNodes.length === 0 && normalizedSearchQuery && (
        <div className="flex h-32 flex-col items-center justify-center gap-2 p-4 text-center">
          <p className="text-sm text-muted-foreground">{t('noResultsFound')}</p>
          <p className="text-xs text-muted-foreground/60">{t('noFilesMatch', { query: searchQuery })}</p>
        </div>
      )}
      <FileContextMenu />
      <BackgroundContextMenu />
      <BulkMoveDialog />
    </div>
  );

  if (variant === 'fullscreen') {
    return (
      <div className="h-full w-full max-w-5xl mx-auto">{treeContent}</div>
    );
  }

  return treeContent;
}
