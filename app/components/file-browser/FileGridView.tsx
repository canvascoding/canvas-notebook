'use client';

import { useRef, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Loader2, AlertCircle, FolderOpen, FolderPlus, Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  SidebarMenu,
  SidebarGroup,
  SidebarGroupContent,
  SidebarProvider,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useFileStore } from '@/app/store/file-store';
import type { FileNode as FileNodeType } from '@/app/lib/files/types';
import { FileTreeNode } from './FileTreeNode';
import { FileContextMenu } from './FileContextMenu';
import { BulkMoveDialog } from './BulkMoveDialog';
import { FileGridItem } from './FileGridItem';
import { BackgroundContextMenu } from './BackgroundContextMenu';
import { useFileExplorerViewModel } from './useFileExplorerViewModel';
import { useMarqueeSelection } from './useMarqueeSelection';
import type { WorkspaceMoveController } from './useWorkspaceMove';
import { useFilePresence } from './useFilePresence';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { FileSortKey } from '@/app/lib/files/sort';

interface FileGridViewProps {
  variant?: 'default' | 'mobile-sheet' | 'fullscreen';
  onOpenFile?: (path: string) => void;
  onFileOpened?: (path: string) => void;
  onUpload?: () => void;
  onCreateFolder?: () => void;
  moveController: WorkspaceMoveController;
  dropTargetPath?: string | null;
}

const FILE_SORT_OPTIONS: Array<{ key: FileSortKey; labelKey: string }> = [
  { key: 'name', labelKey: 'sortName' },
  { key: 'title', labelKey: 'sortTitle' },
  { key: 'type', labelKey: 'sortType' },
  { key: 'created', labelKey: 'sortCreated' },
  { key: 'modified', labelKey: 'sortModified' },
  { key: 'size', labelKey: 'sortSize' },
];

export function FileGridView({
  variant = 'default',
  onOpenFile,
  onFileOpened,
  onUpload,
  onCreateFolder,
  moveController,
  dropTargetPath,
}: FileGridViewProps) {
  useFilePresence();
  const t = useTranslations('notebook');
  const containerRef = useRef<HTMLDivElement>(null);
  const {
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
    isSearching,
    listSelectionOrder,
    loadFileTree,
    loadSubdirectory,
    normalizedSearchQuery,
    searchQuery,
    searchError,
    searchResultTotal,
    searchResultNodes,
    setFileSort,
    treeError,
    treeSelectionOrder,
    visibleSearchResultCount,
  } = useFileExplorerViewModel({ containerRef, variant });
  const { marqueeHandlers, marqueeOverlayRect } = useMarqueeSelection(containerRef);

  const handleFileOpen = useCallback((path: string) => {
    if (onOpenFile) {
      onOpenFile(path);
    } else {
      void useFileStore.getState().revealAndLoadFile(path, { revealInTree: false });
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
    useFileStore.getState().setSearchQuery('');
    useFileStore.getState().setCurrentDirectory(dirPath);
    await loadSubdirectory(dirPath, true);
  }, [loadSubdirectory]);

  const handleNavigateInto = useCallback(async (node: FileNodeType) => {
    if (node.type === 'directory') {
      useFileStore.getState().setSearchQuery('');
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

  const focusItem = useCallback((item: HTMLElement | undefined) => {
    if (!item) return;
    const focusTarget = item.matches('[tabindex]')
      ? item
      : item.querySelector<HTMLElement>('[data-file-primary-action]');
    focusTarget?.focus();
  }, []);

  const handleContainerFocus = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const firstItem = event.currentTarget.querySelector<HTMLElement>('[data-file-path][aria-selected="true"]')
      ?? event.currentTarget.querySelector<HTMLElement>('[data-file-path]');
    focusItem(firstItem ?? undefined);
  }, [focusItem]);

  const handleContainerKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[data-file-action]')) return;
    const currentItem = (event.target as HTMLElement).closest<HTMLElement>('[data-file-path]');
    if (!currentItem || !containerRef.current) return;

    const items = Array.from(
      containerRef.current.querySelectorAll<HTMLElement>('[data-file-path]'),
    ).filter((item) => item.offsetParent !== null);
    const currentIndex = items.indexOf(currentItem);
    if (currentIndex < 0) return;

    let nextIndex = currentIndex;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = items.length - 1;
    else if (event.key === 'ArrowUp') {
      if (browserMode === 'grid') {
        const grid = currentItem.closest<HTMLElement>('[data-file-grid]');
        const columns = grid
          ? Math.max(1, window.getComputedStyle(grid).gridTemplateColumns.split(' ').length)
          : 1;
        nextIndex = Math.max(0, currentIndex - columns);
      } else {
        nextIndex = Math.max(0, currentIndex - 1);
      }
    } else if (event.key === 'ArrowDown') {
      if (browserMode === 'grid') {
        const grid = currentItem.closest<HTMLElement>('[data-file-grid]');
        const columns = grid
          ? Math.max(1, window.getComputedStyle(grid).gridTemplateColumns.split(' ').length)
          : 1;
        nextIndex = Math.min(items.length - 1, currentIndex + columns);
      } else {
        nextIndex = Math.min(items.length - 1, currentIndex + 1);
      }
    } else if (browserMode === 'grid' && event.key === 'ArrowLeft') {
      nextIndex = Math.max(0, currentIndex - 1);
    } else if (browserMode === 'grid' && event.key === 'ArrowRight') {
      nextIndex = Math.min(items.length - 1, currentIndex + 1);
    } else {
      return;
    }

    event.preventDefault();
    focusItem(items[nextIndex]);
  }, [browserMode, focusItem]);

  const searchSummary = normalizedSearchQuery ? (
    <div
      className="mb-3 rounded-md border border-border/70 bg-muted/35 px-3 py-2"
      role="status"
      aria-live="polite"
      data-marquee-ignore
    >
      <p className="truncate text-xs font-medium text-foreground">
        {t('searchResultsSummary', { count: visibleSearchResultCount, query: searchQuery.trim() })}
      </p>
      {searchResultTotal !== null && searchResultTotal > visibleSearchResultCount && (
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {t('searchResultsLimited', { shown: visibleSearchResultCount, total: searchResultTotal })}
        </p>
      )}
    </div>
  ) : null;

  const activeSortLabel = t(
    FILE_SORT_OPTIONS.find((option) => option.key === fileSortKey)?.labelKey ?? 'sortName',
  );
  const SortDirectionIcon = fileSortDirection === 'asc' ? ArrowUp : ArrowDown;
  const sortMenu = (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs text-muted-foreground"
          aria-label={t('sortByCurrent', {
            field: activeSortLabel,
            direction: t(fileSortDirection === 'asc' ? 'sortAscending' : 'sortDescending'),
          })}
        >
          <ArrowUpDown className="h-3.5 w-3.5" />
          <span>{activeSortLabel}</span>
          <SortDirectionIcon className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {FILE_SORT_OPTIONS.map((option) => {
          const isActive = fileSortKey === option.key;
          return (
            <DropdownMenuItem key={option.key} onSelect={() => setFileSort(option.key)}>
              <span className="flex-1">{t(option.labelKey)}</span>
              {isActive && (
                <>
                  <Check className="h-3.5 w-3.5" />
                  <SortDirectionIcon className="h-3.5 w-3.5 text-muted-foreground" />
                </>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const renderSortColumn = (key: FileSortKey, labelKey: string, className?: string) => {
    const isActive = fileSortKey === key;
    return (
      <div className={className}>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-1 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => setFileSort(key)}
          aria-pressed={isActive}
          aria-label={t('sortByCurrent', {
            field: t(labelKey),
            direction: isActive
              ? t(fileSortDirection === 'asc' ? 'sortAscending' : 'sortDescending')
              : t('sortNotActive'),
          })}
        >
          {t(labelKey)}
          {isActive && <SortDirectionIcon className="h-3 w-3" />}
        </button>
      </div>
    );
  };

  const detailedListHeader = (
    <div
      className="hidden grid-cols-[minmax(0,1fr)_7rem_10rem_5rem_2.5rem] items-center gap-3 border-y border-border/70 bg-muted/30 px-2 py-1 md:grid"
      role="toolbar"
      aria-label={t('sortFiles')}
      data-marquee-ignore
    >
      {renderSortColumn('name', 'sortName', 'pl-7')}
      {renderSortColumn('type', 'sortType')}
      {renderSortColumn('modified', 'sortModified')}
      {renderSortColumn('size', 'sortSize', 'text-right')}
      <span aria-hidden="true" />
    </div>
  );

  const renderEmptyState = (compact = false) => (
    <div className={cn('flex h-full flex-col items-center justify-center p-4 text-center', compact ? 'min-h-40' : 'min-h-64')}>
      <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-muted/40">
        <FolderOpen className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="mt-3 text-sm font-medium text-foreground">{t('noFilesFound')}</p>
      <p className="mt-1 max-w-64 text-xs text-muted-foreground">{t('uploadFilesToGetStarted')}</p>
      {(onCreateFolder || onUpload) && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {onCreateFolder && (
            <Button type="button" variant="outline" size="sm" onClick={onCreateFolder}>
              <FolderPlus className="h-4 w-4" />
              {t('newFolder')}
            </Button>
          )}
          {onUpload && (
            <Button type="button" variant="secondary" size="sm" onClick={onUpload}>
              <Upload className="h-4 w-4" />
              {t('upload')}
            </Button>
          )}
        </div>
      )}
    </div>
  );

  const marqueeOverlay = marqueeOverlayRect ? (
    <div
      className="pointer-events-none fixed z-50 rounded-[2px] border border-primary/70 bg-primary/10 shadow-[inset_0_0_0_1px_hsl(var(--background)/0.35)]"
      style={marqueeOverlayRect}
      aria-hidden="true"
      data-marquee-overlay
    />
  ) : null;

  if (isLoadingTree || isRestoring) {
    return (
      <div className="h-full overflow-hidden p-3 md:p-4" role="status" aria-label={t('loadingFiles')}>
        <span className="sr-only">{t('loadingFiles')}</span>
        {browserMode === 'grid' ? (
          <div
            className={cn(
              'grid gap-3',
              variant === 'fullscreen' && 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8',
            )}
            style={variant !== 'fullscreen' ? { gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' } : undefined}
            aria-hidden="true"
          >
            {Array.from({ length: variant === 'fullscreen' ? 12 : 6 }, (_, index) => (
              <div key={index} className="space-y-2 rounded-lg border border-border/60 p-3">
                <Skeleton className="aspect-[4/3] w-full" />
                <Skeleton className="h-3 w-3/4" />
                <Skeleton className="h-2.5 w-1/2" />
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2" aria-hidden="true">
            {Array.from({ length: 8 }, (_, index) => (
              <div key={index} className="flex items-center gap-3 rounded-md px-2 py-1.5">
                <Skeleton className="h-5 w-5 shrink-0" />
                <Skeleton className="h-3.5" style={{ width: `${48 + (index % 4) * 9}%` }} />
              </div>
            ))}
          </div>
        )}
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
      <div
        ref={containerRef}
        className="relative h-full overflow-y-auto focus:outline-none"
        onContextMenu={handleBackgroundContextMenu}
        {...marqueeHandlers}
        tabIndex={0}
        aria-label={browserMode === 'grid' ? t('fileGridLabel') : browserMode === 'list' ? t('fileListLabel') : t('fileTreeLabel')}
      >
        {renderEmptyState()}
        {marqueeOverlay}
        <BackgroundContextMenu onFileOpened={onFileOpened} />
      </div>
    );
  }

  if (browserMode === 'grid') {
    return (
      <div
        ref={containerRef}
        className="h-full overflow-y-auto p-3 md:p-4 focus:outline-none"
        onContextMenu={handleBackgroundContextMenu}
        onFocus={handleContainerFocus}
        onKeyDown={handleContainerKeyDown}
        {...marqueeHandlers}
        tabIndex={0}
        aria-label={t('fileGridLabel')}
      >
        {searchSummary}
        {gridItems.length === 0 && !searchQuery ? (
          renderEmptyState()
        ) : (
          <div
            className={cn('grid gap-3', variant === 'fullscreen' && 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8')}
            style={variant !== 'fullscreen' ? { gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' } : undefined}
            role="grid"
            aria-label={t('fileGridLabel')}
            data-file-grid
          >
            {gridItems.map((node) => (
              <FileGridItem
                key={node.path}
                node={node}
                onOpenFile={handleFileOpen}
                onOpenDirectory={handleOpenDirectory}
                size={variant === 'fullscreen' ? 'lg' : 'sm'}
                selectionOrder={gridSelectionOrder}
                showPath={Boolean(normalizedSearchQuery)}
                openOnSingleClick={variant !== 'fullscreen'}
                dropTargetPath={dropTargetPath}
              />
            ))}
          </div>
        )}
        {isSearching && normalizedSearchQuery && (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {searchError && normalizedSearchQuery && (
          <div className="mx-auto mt-3 max-w-md rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-center text-xs text-destructive">
            {searchError}
          </div>
        )}
        {!isSearching && gridItems.length === 0 && normalizedSearchQuery && (
          <div className="flex h-32 flex-col items-center justify-center gap-2 p-4 text-center">
            <p className="text-sm text-muted-foreground">{t('noResultsFound')}</p>
            <p className="text-xs text-muted-foreground/60">{t('noFilesMatch', { query: searchQuery })}</p>
          </div>
        )}
        {marqueeOverlay}
        <FileContextMenu />
        <BackgroundContextMenu onFileOpened={onFileOpened} />
        <BulkMoveDialog controller={moveController} />
      </div>
    );
  }

  if (browserMode === 'list') {
    const listContent = (
      <div
        ref={containerRef}
        className="relative h-full overflow-y-auto py-2 focus:outline-none"
        tabIndex={0}
        onContextMenu={handleBackgroundContextMenu}
        onFocus={handleContainerFocus}
        onKeyDown={handleContainerKeyDown}
        {...marqueeHandlers}
        aria-label={t('fileListLabel')}
      >
        <div className="px-2">{searchSummary}</div>
        {currentDirectory !== '.' && (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            onClick={handleNavigateUp}
          >
            <span>↑ {t('goUpFolder')}</span>
          </button>
        )}
        {variant === 'fullscreen' && detailedListHeader}
        <div className={cn('flex justify-end px-2 pb-1', variant === 'fullscreen' && 'md:hidden')}>
          {sortMenu}
        </div>
        <SidebarProvider>
          <SidebarGroup className="p-0">
            <SidebarGroupContent>
              <SidebarMenu className="space-y-0.5" role="listbox" aria-label={t('fileListLabel')}>
                {filteredListChildren && filteredListChildren.length === 0 && !searchQuery && (
                  <li role="presentation">{renderEmptyState(true)}</li>
                )}
                {filteredListChildren?.map((node: FileNodeType) => (
                  <FileTreeNode
                    key={node.path}
                    node={node}
                    browserMode="list"
                    onNavigateInto={handleNavigateInto}
                    onOpenFile={handleFileOpen}
                    selectionOrder={listSelectionOrder}
                    showPath={Boolean(normalizedSearchQuery)}
                    openOnSingleClick={variant !== 'fullscreen'}
                    showListMetadata={variant === 'fullscreen'}
                    dropTargetPath={dropTargetPath}
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
        {searchError && normalizedSearchQuery && (
          <div className="mx-3 mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {searchError}
          </div>
        )}
        {!isSearching && filteredListChildren && filteredListChildren.length === 0 && normalizedSearchQuery && (
          <div className="flex h-32 flex-col items-center justify-center gap-2 p-4 text-center">
            <p className="text-sm text-muted-foreground">{t('noResultsFound')}</p>
            <p className="text-xs text-muted-foreground/60">{t('noFilesMatch', { query: searchQuery })}</p>
          </div>
        )}
        {marqueeOverlay}
        <FileContextMenu />
        <BackgroundContextMenu onFileOpened={onFileOpened} />
        <BulkMoveDialog controller={moveController} />
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
    <div
      ref={containerRef}
      className="relative h-full overflow-y-auto py-2 focus:outline-none"
      tabIndex={0}
      onContextMenu={handleBackgroundContextMenu}
      onFocus={handleContainerFocus}
      onKeyDown={handleContainerKeyDown}
      {...marqueeHandlers}
      aria-label={t('fileTreeLabel')}
    >
      <div className="px-2">{searchSummary}</div>
      <SidebarProvider>
        <SidebarGroup className="p-0">
          <SidebarGroupContent>
            <SidebarMenu className="space-y-0.5" role="tree" aria-label={t('fileTreeLabel')}>
              {searchResultNodes.map((node) => (
                <FileTreeNode
                  key={node.path}
                  node={node}
                  onOpenFile={handleFileOpen}
                  selectionOrder={treeSelectionOrder}
                  showPath={Boolean(normalizedSearchQuery)}
                  dropTargetPath={dropTargetPath}
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
      {searchError && normalizedSearchQuery && (
        <div className="mx-3 mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {searchError}
        </div>
      )}
      {!isSearching && searchResultNodes.length === 0 && normalizedSearchQuery && (
        <div className="flex h-32 flex-col items-center justify-center gap-2 p-4 text-center">
          <p className="text-sm text-muted-foreground">{t('noResultsFound')}</p>
          <p className="text-xs text-muted-foreground/60">{t('noFilesMatch', { query: searchQuery })}</p>
        </div>
      )}
      {marqueeOverlay}
      <FileContextMenu />
      <BackgroundContextMenu onFileOpened={onFileOpened} />
      <BulkMoveDialog controller={moveController} />
    </div>
  );

  if (variant === 'fullscreen') {
    return (
      <div className="h-full w-full max-w-5xl mx-auto">{treeContent}</div>
    );
  }

  return treeContent;
}
