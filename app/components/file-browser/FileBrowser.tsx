'use client';

import { useRef, useState, useCallback, type DragEvent } from 'react';
import { ChevronsDownUp, ChevronLeft, CheckSquare, Download, FilePlus, FolderPlus, House, MoreHorizontal, Move, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useFileStore, type FileNode } from '@/app/store/file-store';
import { FileTree } from './FileTree';
import { CreateItemDialog } from './CreateItemDialog';
import { UploadDialog } from './UploadDialog';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { useFileWatcher, type FileEvent } from '@/app/hooks/useFileWatcher';
import { useIsMobile } from '@/hooks/use-mobile';
import { getDroppedFiles } from '@/app/lib/drop-traverse';

interface FileBrowserProps {
  variant?: 'default' | 'mobile-sheet';
}

export function FileBrowser({ variant = 'default' }: FileBrowserProps) {
  const t = useTranslations('notebook');
  const dragCounter = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<'file' | 'directory'>('file');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePaths, setDeletePaths] = useState<string[]>([]);
  const [deleteSkippedCount, setDeleteSkippedCount] = useState(0);
  const isMobile = useIsMobile();
  const isMobileSheet = variant === 'mobile-sheet';
  
  const handleFileEvent = useCallback((event: FileEvent) => {
    console.log('[FileBrowser] File change event:', event);
  }, []);
  
  const { isConnected } = useFileWatcher({
    enabled: true,
    debounceMs: 1000,
    maxDebounceMs: 5000,
    onEvent: handleFileEvent,
  });
  
  const {
    isLoadingTree,
    loadFileTree,
    selectedNode,
    createPath,
    deletePath,
    uploadFile,
    uploadProgress,
    currentDirectory,
    searchQuery,
    setSearchQuery,
    collapseAllDirectories,
    fileTree,
    isMultiSelectMode,
    toggleMultiSelectMode,
    multiSelectPaths,
    clearMultiSelect,
    downloadFile,
  } = useFileStore();

  const findPathInTree = (path: string, tree: FileNode[]): boolean => {
    for (const node of tree) {
      if (node.path === path) return true;
      if (node.children && findPathInTree(path, node.children)) return true;
    }
    return false;
  };

  const resolveTargetDir = () => {
    if (currentDirectory && currentDirectory !== '.' && !findPathInTree(currentDirectory, fileTree)) {
      console.warn(`Target directory "${currentDirectory}" no longer exists. Falling back to root.`);
      useFileStore.getState().setCurrentDirectory('.');
      return '.';
    }

    if (currentDirectory) {
      return currentDirectory;
    }
    
    if (!selectedNode) {
      return '.';
    }
    if (selectedNode.type === 'directory') {
      return selectedNode.path;
    }
    const trimmed = selectedNode.path.replace(/\/+$/, '');
    const lastSlash = trimmed.lastIndexOf('/');
    if (lastSlash <= 0) {
      return '.';
    }
    return trimmed.slice(0, lastSlash);
  };

  const handleNewFile = () => {
    setCreateType('file');
    setCreateOpen(true);
  };

  const handleNewFolder = () => {
    setCreateType('directory');
    setCreateOpen(true);
  };

  const handleCreate = async (fullPath: string, itemType: 'file' | 'directory') => {
    await createPath(fullPath, itemType);
  };

  const handleUploadClick = () => {
    setUploadOpen(true);
  };

  const handleUpload = async (files: File[], targetDir: string) => {
    await uploadFile(files, targetDir);
  };

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragCounter.current += 1;
    setIsDragging(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      setIsDragging(false);
    }
  };

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
  };

  const handleDrop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragCounter.current = 0;
    setIsDragging(false);

    const dropped = await getDroppedFiles(event.dataTransfer);
    if (dropped.length === 0) return;

    const files = dropped.map((d) => d.file);
    const pathMap = new Map<File, string>();
    for (const d of dropped) {
      pathMap.set(d.file, d.relativePath);
    }

    const targetDir = resolveTargetDir();
    await uploadFile(files, targetDir, pathMap);
  };

  const handleDeleteClick = () => {
    if (isMultiSelectMode) {
      const pathsToDelete = Array.from(multiSelectPaths).filter((path) => !isProtectedAppOutputFolder(path));
      const skippedCount = multiSelectPaths.length - pathsToDelete.length;
      if (pathsToDelete.length === 0) {
        if (skippedCount > 0) {
          toast.error(t('protectedFoldersDeleteOnly'));
        }
        return;
      }
      setDeletePaths(pathsToDelete);
      setDeleteSkippedCount(skippedCount);
      setDeleteOpen(true);
    } else if (selectedNode) {
      if (selectedNode.type === 'directory' && isProtectedAppOutputFolder(selectedNode.path)) {
        toast.error(t('protectedFolderDelete'));
        return;
      }
      setDeletePaths([selectedNode.path]);
      setDeleteSkippedCount(0);
      setDeleteOpen(true);
    }
  };

  const handleConfirmDelete = async () => {
    await deletePath(deletePaths);
    if (deleteSkippedCount > 0) {
      toast.info(t('protectedFoldersSkipped', { count: deleteSkippedCount }));
    }
    clearMultiSelect();
  };

  const deletableMultiSelectCount = multiSelectPaths.filter((path) => !isProtectedAppOutputFolder(path)).length;
  const hasProtectedSelected = multiSelectPaths.some(path => isProtectedAppOutputFolder(path));
  const isDeleteDisabled =
    (!selectedNode && multiSelectPaths.length === 0) ||
    (isMultiSelectMode
      ? deletableMultiSelectCount === 0
      : selectedNode?.type === 'directory' && isProtectedAppOutputFolder(selectedNode.path));
  const currentDirectoryLabel = currentDirectory === '.' ? t('workspaceRoot') : `/${currentDirectory}`;

  const handleBulkMove = () => {
    if (hasProtectedSelected) {
      toast.error(t('protectedFolderMove'));
      return;
    }
    window.dispatchEvent(new CustomEvent('notebook-bulk-move-open'));
  };

  const handleBulkDownload = async () => {
    for (const path of multiSelectPaths) {
      try {
        await downloadFile(path);
      } catch (error) {
        console.error(`Failed to download ${path}:`, error);
      }
    }
    toast.success(t('download'));
  };

  const navigateToDirectory = useCallback(
    async (targetDir: string) => {
      useFileStore.getState().setCurrentDirectory(targetDir);
      await loadFileTree(targetDir, undefined, true);
    },
    [loadFileTree]
  );

  const handleGoRoot = useCallback(async () => {
    await navigateToDirectory('.');
  }, [navigateToDirectory]);

  const handleGoUp = useCallback(async () => {
    if (currentDirectory === '.') {
      return;
    }
    const parts = currentDirectory.split('/').filter(Boolean);
    const parentDir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
    await navigateToDirectory(parentDir);
  }, [currentDirectory, navigateToDirectory]);

  const handleRefresh = useCallback(async () => {
    await loadFileTree(currentDirectory, undefined, true);
    const { currentFile } = useFileStore.getState();
    if (currentFile) {
      useFileStore.getState().loadFile(currentFile.path, true);
    }
  }, [currentDirectory, loadFileTree]);

  return (
    <section
      style={{ width: '100%', minWidth: 0, flex: '1 1 0%' }}
      className={cn(
        'relative flex h-full w-full min-w-0 flex-1 flex-col',
        isMobileSheet
          ? 'overflow-hidden bg-background'
          : 'overflow-y-auto bg-sidebar/50 md:border-r md:border-border',
        isDragging && 'bg-accent/50'
      )}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center border-2 border-dashed border-border bg-background/95 text-sm text-foreground">
          {t('dropFilesToUpload')}
        </div>
      )}
      <div className="sticky top-0 z-20 border-b border-border bg-background/95">
        {isMobileSheet ? (
          <div className="flex items-center gap-2 px-3 py-2">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 gap-2 rounded-full px-3">
                  <MoreHorizontal className="h-4 w-4" />
                  {t('actions')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" sideOffset={8} className="w-56">
                <DropdownMenuItem onSelect={handleNewFile}>
                  <FilePlus className="h-4 w-4" />
                  {t('newFile')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleNewFolder}>
                  <FolderPlus className="h-4 w-4" />
                  {t('newFolder')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleUploadClick}>
                  <Upload className="h-4 w-4" />
                  {t('uploadFile')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={toggleMultiSelectMode}>
                  <CheckSquare className={cn('h-4 w-4', isMultiSelectMode && 'text-primary')} />
                  {isMultiSelectMode ? t('multiSelectDone') : t('multiSelect')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={collapseAllDirectories}>
                  <ChevronsDownUp className="h-4 w-4" />
                  {t('collapseAllFolders')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void handleRefresh()} disabled={isLoadingTree}>
                  <RefreshCw className={cn('h-4 w-4', isLoadingTree && 'animate-spin')} />
                  {t('refresh')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleDeleteClick} disabled={isDeleteDisabled}>
                  <Trash2 className="h-4 w-4" />
                  {t('deleteSelection')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void handleRefresh()}
              disabled={isLoadingTree}
              aria-label={t('refreshFileTree')}
            >
              <RefreshCw className={cn('h-4 w-4', isLoadingTree && 'animate-spin')} />
            </Button>
            <div className="ml-auto flex items-center gap-2 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              <span
                className={cn(
                  'h-2 w-2 rounded-full transition-colors',
                  isConnected ? 'bg-green-500' : 'bg-amber-500'
                )}
              />
              {t('sync')}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-x-2 px-3 py-2">
            <h2 className="shrink-0 text-sm font-semibold text-foreground">{t('filesTitle')}</h2>
            <TooltipProvider delayDuration={300}>
              <div className="flex min-w-0 flex-1 items-center justify-start gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={toggleMultiSelectMode}
                      aria-label={t('toggleSelectMode')}
                    >
                      <CheckSquare className={`h-4 w-4 ${isMultiSelectMode ? 'text-primary' : ''}`} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('select')}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={handleNewFile}
                      aria-label={t('newFile')}
                    >
                      <FilePlus className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('newFile')}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={handleNewFolder}
                      aria-label={t('newFolder')}
                    >
                      <FolderPlus className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('newFolder')}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={handleUploadClick}
                      aria-label={t('upload')}
                    >
                      <Upload className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('upload')}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={handleDeleteClick}
                      disabled={isDeleteDisabled}
                      aria-label={t('delete')}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('delete')}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={collapseAllDirectories}
                      aria-label={t('collapseAllFolders')}
                    >
                      <ChevronsDownUp className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('collapseAll')}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void handleRefresh()}
                      disabled={isLoadingTree}
                      aria-label={t('refreshFileTree')}
                    >
                      <RefreshCw
                        className={cn('h-4 w-4', isLoadingTree && 'animate-spin')}
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t('refresh')}</TooltipContent>
                </Tooltip>
                <div className="ml-auto flex items-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className={cn(
                        'flex h-2 w-2 rounded-full transition-colors',
                        isConnected ? 'bg-green-500' : 'bg-amber-500'
                      )} />
                    </TooltipTrigger>
                    <TooltipContent>
                      {isConnected ? t('autoRefreshConnected') : t('autoRefreshDisconnected')}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </TooltipProvider>
          </div>
        )}
        {isMultiSelectMode && (
          <div className="flex items-center justify-between gap-2 border-t border-border bg-muted/40 px-3 py-1 text-xs">
            <span className="text-muted-foreground">{t('selectedCount', { count: multiSelectPaths.length })}</span>
            <div className="flex items-center gap-1">
              {multiSelectPaths.length > 0 && (
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={handleBulkMove}
                    disabled={hasProtectedSelected}
                    title={t('move')}
                  >
                    <Move className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => void handleBulkDownload()}
                    title={t('download')}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={toggleMultiSelectMode}
              >
                <X className="mr-1 h-3 w-3" />
                {t('cancel')}
              </Button>
            </div>
          </div>
        )}
        {(isMobile || isMobileSheet) && (
          <div className="border-t border-border bg-muted/30 px-3 py-2">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2 text-xs"
                onClick={() => void handleGoRoot()}
                aria-label={t('jumpToWorkspaceRoot')}
              >
                <House className="h-3.5 w-3.5" />
                <span>{t('root')}</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2 text-xs"
                onClick={() => void handleGoUp()}
                disabled={currentDirectory === '.'}
                aria-label={t('goUpOneFolder')}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                <span>{t('up')}</span>
              </Button>
              <div className="min-w-0 flex-1 truncate border border-border bg-background px-2 py-1.5 text-xs text-muted-foreground">
                {currentDirectoryLabel}
              </div>
            </div>
          </div>
        )}
        {!isMobile && !isMobileSheet && (
          <div className="border-t border-border px-3 py-2">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2 text-xs"
                onClick={() => void handleGoRoot()}
                aria-label={t('jumpToWorkspaceRoot')}
              >
                <House className="h-3.5 w-3.5" />
                <span>{t('root')}</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2 text-xs"
                onClick={() => void handleGoUp()}
                disabled={currentDirectory === '.'}
                aria-label={t('goUpOneFolder')}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                <span>{t('up')}</span>
              </Button>
              <div className="min-w-0 flex-1 truncate border border-border bg-background px-2 py-1.5 text-xs text-muted-foreground">
                {currentDirectoryLabel}
              </div>
            </div>
          </div>
        )}
        <div className="border-t border-border px-3 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t('searchFiles')}
              className="h-9 bg-background pl-8 placeholder:text-muted-foreground"
            />
          </div>
          {uploadProgress !== null && (
            <div className="mt-2 h-1 w-full overflow-hidden bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <FileTree />
      </div>

      <CreateItemDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        type={createType}
        defaultPath={resolveTargetDir()}
        onCreate={handleCreate}
      />

      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        defaultPath={resolveTargetDir()}
        onUpload={handleUpload}
      />

      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        paths={deletePaths}
        skippedCount={deleteSkippedCount}
        onConfirm={handleConfirmDelete}
      />
    </section>
  );
}