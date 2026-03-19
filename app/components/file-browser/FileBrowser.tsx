'use client';

import { useRef, useState, useCallback, type ChangeEvent, type DragEvent } from 'react';
import { ChevronsDownUp, ChevronLeft, CheckSquare, FilePlus, FolderPlus, House, MoreHorizontal, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react';
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
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { useFileWatcher, type FileEvent } from '@/app/hooks/useFileWatcher';
import { useIsMobile } from '@/hooks/use-mobile';

interface FileBrowserProps {
  variant?: 'default' | 'mobile-sheet';
}

export function FileBrowser({ variant = 'default' }: FileBrowserProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounter = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const isMobile = useIsMobile();
  const isMobileSheet = variant === 'mobile-sheet';
  
  // Stable callback for file watcher - memoized with useCallback
  const handleFileEvent = useCallback((event: FileEvent) => {
    console.log('[FileBrowser] File change event:', event);
  }, []);
  
  // File watcher für automatische Updates
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

  const handleNewFile = async () => {
    const name = window.prompt('New file name');
    if (!name) return;
    const targetDir = resolveTargetDir();
    const targetPath = targetDir === '.' ? name : `${targetDir}/${name}`;
    await createPath(targetPath, 'file');
  };

  const handleNewFolder = async () => {
    const name = window.prompt('New folder name');
    if (!name) return;
    const targetDir = resolveTargetDir();
    const targetPath = targetDir === '.' ? name : `${targetDir}/${name}`;
    await createPath(targetPath, 'directory');
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleUploadFolderClick = () => {
    folderInputRef.current?.click();
  };

  const handleUploadChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    const targetDir = resolveTargetDir();
    await uploadFile(files, targetDir);
    event.target.value = '';
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
    const droppedFiles = Array.from(event.dataTransfer.files ?? []);
    if (droppedFiles.length === 0) return;
    
    const targetDir = resolveTargetDir();
    await uploadFile(droppedFiles, targetDir);
  };

  const handleDeleteClick = async () => {
    if (isMultiSelectMode) {
      const pathsToDelete = Array.from(multiSelectPaths).filter((path) => !isProtectedAppOutputFolder(path));
      const skippedCount = multiSelectPaths.length - pathsToDelete.length;
      if (pathsToDelete.length === 0) {
        if (skippedCount > 0) {
          toast.error('App output folders cannot be deleted.');
        }
        return;
      }

      const confirmed = window.confirm(
        skippedCount > 0
          ? `Delete ${pathsToDelete.length} items? ${skippedCount} protected app folder(s) will be skipped.`
          : `Are you sure you want to delete ${pathsToDelete.length} items?`
      );
      if (confirmed) {
        await deletePath(pathsToDelete);
        if (skippedCount > 0) {
          toast.info(`${skippedCount} protected app folder(s) were not deleted.`);
        }
        clearMultiSelect();
      }
    } else if (selectedNode) {
      if (selectedNode.type === 'directory' && isProtectedAppOutputFolder(selectedNode.path)) {
        toast.error('This app output folder cannot be deleted.');
        return;
      }
      const confirmed = window.confirm(`Are you sure you want to delete "${selectedNode.name}"?`);
      if (confirmed) {
        await deletePath(selectedNode.path);
      }
    }
  };

  const deletableMultiSelectCount = multiSelectPaths.filter((path) => !isProtectedAppOutputFolder(path)).length;
  const isDeleteDisabled =
    (!selectedNode && multiSelectPaths.length === 0) ||
    (isMultiSelectMode
      ? deletableMultiSelectCount === 0
      : selectedNode?.type === 'directory' && isProtectedAppOutputFolder(selectedNode.path));
  const currentDirectoryLabel = currentDirectory === '.' ? 'Workspace /' : `/${currentDirectory}`;

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
          Drop files to upload
        </div>
      )}
      <div className="sticky top-0 z-20 border-b border-border bg-background/95">
        {isMobileSheet ? (
          <div className="flex items-center gap-2 px-3 py-2">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 gap-2 rounded-full px-3">
                  <MoreHorizontal className="h-4 w-4" />
                  Aktionen
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" sideOffset={8} className="w-56">
                <DropdownMenuItem onSelect={handleNewFile}>
                  <FilePlus className="h-4 w-4" />
                  Neue Datei
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleNewFolder}>
                  <FolderPlus className="h-4 w-4" />
                  Neuer Ordner
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleUploadClick}>
                  <Upload className="h-4 w-4" />
                  Datei hochladen
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleUploadFolderClick}>
                  <FolderPlus className="h-4 w-4 text-primary" />
                  Ordner hochladen
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={toggleMultiSelectMode}>
                  <CheckSquare className={cn('h-4 w-4', isMultiSelectMode && 'text-primary')} />
                  {isMultiSelectMode ? 'Mehrfachauswahl beenden' : 'Mehrfachauswahl'}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={collapseAllDirectories}>
                  <ChevronsDownUp className="h-4 w-4" />
                  Alle Ordner einklappen
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void handleRefresh()} disabled={isLoadingTree}>
                  <RefreshCw className={cn('h-4 w-4', isLoadingTree && 'animate-spin')} />
                  Aktualisieren
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void handleDeleteClick()} disabled={isDeleteDisabled}>
                  <Trash2 className="h-4 w-4" />
                  Auswahl löschen
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void handleRefresh()}
              disabled={isLoadingTree}
              aria-label="Refresh file tree"
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
              Sync
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
            <h2 className="shrink-0 text-sm font-semibold text-foreground">Files</h2>
            <TooltipProvider delayDuration={300}>
              <div className="flex min-w-[180px] flex-1 flex-wrap content-start items-center justify-start gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={toggleMultiSelectMode}
                      aria-label="Toggle select mode"
                    >
                      <CheckSquare className={`h-4 w-4 ${isMultiSelectMode ? 'text-primary' : ''}`} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Select</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={handleNewFile}
                      aria-label="New file"
                    >
                      <FilePlus className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>New file</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={handleNewFolder}
                      aria-label="New folder"
                    >
                      <FolderPlus className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>New folder</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={handleUploadFolderClick}
                      aria-label="Upload folder"
                    >
                      <FolderPlus className="h-4 w-4 text-primary" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Upload folder</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={handleUploadClick}
                      aria-label="Upload files"
                    >
                      <Upload className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Upload files</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={handleDeleteClick}
                      disabled={isDeleteDisabled}
                      aria-label="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Delete</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={collapseAllDirectories}
                      aria-label="Collapse all folders"
                    >
                      <ChevronsDownUp className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Collapse all</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void handleRefresh()}
                      disabled={isLoadingTree}
                      aria-label="Refresh file tree"
                    >
                      <RefreshCw
                        className={cn('h-4 w-4', isLoadingTree && 'animate-spin')}
                      />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Refresh</TooltipContent>
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
                      {isConnected ? 'Auto-refresh: Connected' : 'Auto-refresh: Disconnected'}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </TooltipProvider>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleUploadChange}
          multiple
        />
        <input
          ref={folderInputRef}
          type="file"
          className="hidden"
          onChange={handleUploadChange}
          {...{ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>}
          multiple
        />
        {isMultiSelectMode && (
          <div className="flex items-center justify-between gap-2 border-t border-border bg-muted/40 px-3 py-1 text-xs">
            <span className="text-muted-foreground">{multiSelectPaths.length} selected</span>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={toggleMultiSelectMode}
            >
              <X className="mr-1 h-3 w-3" />
              Cancel
            </Button>
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
                aria-label="Jump to workspace root"
              >
                <House className="h-3.5 w-3.5" />
                <span>Root</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2 text-xs"
                onClick={() => void handleGoUp()}
                disabled={currentDirectory === '.'}
                aria-label="Go up one folder"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                <span>Up</span>
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
              placeholder="Search files"
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
    </section>
  );
}
