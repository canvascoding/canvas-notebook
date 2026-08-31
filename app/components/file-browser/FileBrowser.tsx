'use client';

import { useRef, useState, useCallback, useEffect, type DragEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, Download, Globe2, Move, Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useFileStore } from '@/app/store/file-store';
import { getParentDirectory, normalizeWorkspacePathParam } from '@/app/lib/files/path-utils';
import { findPathInTree } from '@/app/lib/files/tree-utils';
import { FileGridView } from './FileGridView';
import { FileToolbar, type FileToolbarHandlers } from './FileToolbar';
import { FileBreadcrumb } from './FileBreadcrumb';
import { CreateItemDialog } from './CreateItemDialog';
import { UploadDialog } from './UploadDialog';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { isProtectedDirectoryNode, splitProtectedWorkspacePaths } from '@/app/lib/files/operation-flows';
import { useImagePreprocess } from '@/app/hooks/useImagePreprocess';
import { ImagePreprocessDialog } from '@/app/components/shared/ImagePreprocessDialog';
import { getDroppedFiles } from '@/app/lib/drop-traverse';
import { FilePreviewDialog } from '@/app/components/files/FilePreviewDialog';
import { Link } from '@/i18n/navigation';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { notifyWorkspaceFileOpened } from '@/app/lib/files/workspace-file-events';
import { PublicShareDialog } from './PublicShareDialog';
import { useCreateItemDialog } from './useCreateItemDialog';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { useEditorStore } from '@/app/store/editor-store';
import { invalidateFileReferenceValidationCache } from '@/app/lib/chat/validate-file-paths';
import { useShallow } from 'zustand/react/shallow';
import { useTrashUndo } from './useTrashUndo';
import { UploadProgress } from './UploadProgress';
import { useWorkspaceMove } from './useWorkspaceMove';
import { useFileMoveDrag } from './useFileMoveDrag';


import { AppLauncher } from '@/app/components/AppLauncher';
import { NotificationBell } from '@/app/components/notifications/NotificationBell';
import { WorkspaceSwitcher } from '@/app/components/workspaces/WorkspaceSwitcher';

interface FileBrowserProps {
  variant?: 'default' | 'mobile-sheet' | 'fullscreen';
  onFileSelect?: (path: string) => void;
}

export function FileBrowser({ variant = 'default', onFileSelect }: FileBrowserProps) {
  const t = useTranslations('notebook');
  const tCommon = useTranslations('common');
  const searchParams = useSearchParams();
  const dragCounter = useRef(0);
  const openedPathParamRef = useRef<string | null>(null);
  const pendingPathParamRef = useRef<string | null>(null);
  const activeWorkspaceIdRef = useRef<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePaths, setDeletePaths] = useState<string[]>([]);
  const [deleteSkippedCount, setDeleteSkippedCount] = useState(0);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [publicShareOpen, setPublicShareOpen] = useState(false);
  const [publicSharePaths, setPublicSharePaths] = useState<string[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const isFullscreen = variant === 'fullscreen';
  const isMobileSheet = variant === 'mobile-sheet';

  const handleFileOpened = useCallback((path: string) => {
    if (isFullscreen) setActiveFilePath(path);
    onFileSelect?.(path);
  }, [isFullscreen, onFileSelect]);

  const {
    refreshDirectory,
    refreshVisibleTree,
    selectedNode,
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
    revealAndLoadFile,
    setBulkMoveOpen,
    currentFile,
    refreshCurrentFileContent,
  } = useFileStore(useShallow((state) => ({
    refreshDirectory: state.refreshDirectory,
    refreshVisibleTree: state.refreshVisibleTree,
    selectedNode: state.selectedNode,
    uploadFile: state.uploadFile,
    uploadProgress: state.uploadProgress,
    currentDirectory: state.currentDirectory,
    searchQuery: state.searchQuery,
    setSearchQuery: state.setSearchQuery,
    collapseAllDirectories: state.collapseAllDirectories,
    fileTree: state.fileTree,
    isMultiSelectMode: state.isMultiSelectMode,
    toggleMultiSelectMode: state.toggleMultiSelectMode,
    multiSelectPaths: state.multiSelectPaths,
    clearMultiSelect: state.clearMultiSelect,
    downloadFile: state.downloadFile,
    revealAndLoadFile: state.revealAndLoadFile,
    setBulkMoveOpen: state.setBulkMoveOpen,
    currentFile: state.currentFile,
    refreshCurrentFileContent: state.refreshCurrentFileContent,
  })));
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const deleteWithUndo = useTrashUndo();
  const moveController = useWorkspaceMove();
  const fileMoveDrag = useFileMoveDrag({ controller: moveController });

  useEffect(() => {
    if (!activeWorkspaceId) return;
    const previousWorkspaceId = activeWorkspaceIdRef.current;
    activeWorkspaceIdRef.current = activeWorkspaceId;

    if (!previousWorkspaceId || previousWorkspaceId === activeWorkspaceId) return;

    openedPathParamRef.current = null;
    pendingPathParamRef.current = null;
    setActiveFilePath(null);
    setPublicShareOpen(false);
    setPublicSharePaths([]);
    setUploadOpen(false);
    setDeleteOpen(false);
    setDeletePaths([]);
    setDeleteSkippedCount(0);
  }, [activeWorkspaceId]);

  const isDirectoryReachableInTree = useCallback(
    (dirPath: string) => {
      if (dirPath === '.') return true;
      if (fileTree.length === 0) return true;
      if (findPathInTree(dirPath, fileTree)) return true;
      const [rootSegment] = dirPath.split('/');
      return fileTree.some((node) => node.type === 'directory' && node.path === rootSegment);
    },
    [fileTree]
  );

  const imagePreprocess = useImagePreprocess({
    onUpload: async (files, convertParams, targetDir, pathMap, options) => {
      const dir = targetDir || resolveTargetDir();
      await uploadFile(files, dir, pathMap, convertParams, options);
    },
    onBatchComplete: async (targetDir) => {
      const dir = targetDir || resolveTargetDir();
      await refreshDirectory(dir, true);
      invalidateFileReferenceValidationCache();
    },
  });

  useEffect(() => {
    if (currentDirectory && currentDirectory !== '.' && !isDirectoryReachableInTree(currentDirectory)) {
      useFileStore.getState().setCurrentDirectory('.');
    }
  }, [currentDirectory, isDirectoryReachableInTree]);

  const resolveTargetDir = () => {
    if (currentDirectory && currentDirectory !== '.' && isDirectoryReachableInTree(currentDirectory)) {
      return currentDirectory;
    }
    if (!selectedNode) return '.';
    if (selectedNode.type === 'directory') return selectedNode.path;
    const trimmed = selectedNode.path.replace(/\/+$/, '');
    const lastSlash = trimmed.lastIndexOf('/');
    if (lastSlash <= 0) return '.';
    return trimmed.slice(0, lastSlash);
  };

  const { createDialogProps, openCreateDialog } = useCreateItemDialog({
    onFileOpened: handleFileOpened,
  });
  const handleNewFile = () => openCreateDialog('file');
  const handleNewExcalidraw = () => openCreateDialog('excalidraw');
  const handleNewFolder = () => openCreateDialog('directory');
  const handleUploadClick = () => { setUploadOpen(true); };
  const handleUpload = async (files: File[], targetDir: string) => { await imagePreprocess.handleFiles(files, targetDir); };

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    if (fileMoveDrag.isWorkspaceFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    dragCounter.current += 1;
    setIsDragging(true);
  };
  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (fileMoveDrag.isWorkspaceFileDrag(event.dataTransfer)) {
      fileMoveDrag.handlers.onDragLeave(event);
      return;
    }
    event.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) { dragCounter.current = 0; setIsDragging(false); }
  };
  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (fileMoveDrag.isWorkspaceFileDrag(event.dataTransfer)) {
      fileMoveDrag.handlers.onDragOver(event);
      return;
    }
    event.preventDefault();
  };
  const handleDrop = async (event: DragEvent<HTMLElement>) => {
    if (fileMoveDrag.isWorkspaceFileDrag(event.dataTransfer)) {
      await fileMoveDrag.handlers.onDrop(event);
      return;
    }
    event.preventDefault();
    dragCounter.current = 0;
    setIsDragging(false);
    try {
      const dropped = await getDroppedFiles(event.dataTransfer);
      if (dropped.length === 0) return;
      const files = dropped.map((d) => d.file);
      const pathMap = new Map<File, string>();
      for (const d of dropped) { pathMap.set(d.file, d.relativePath); }
      const targetDir = resolveTargetDir();
      await imagePreprocess.handleFiles(files, targetDir, pathMap);
    } catch (uploadError) {
      toast.error(uploadError instanceof Error ? uploadError.message : t('uploadFailed'));
    }
  };

  const handleDeleteClick = () => {
    if (isMultiSelectMode) {
      const deleteSelection = splitProtectedWorkspacePaths(multiSelectPaths);
      if (deleteSelection.allowedPaths.length === 0) {
        if (deleteSelection.skippedCount > 0) toast.error(t('protectedFoldersDeleteOnly'));
        return;
      }
      setDeletePaths(deleteSelection.allowedPaths);
      setDeleteSkippedCount(deleteSelection.skippedCount);
      setDeleteOpen(true);
    } else if (selectedNode) {
      if (isProtectedDirectoryNode(selectedNode)) {
        toast.error(t('protectedFolderDelete')); return;
      }
      setDeletePaths([selectedNode.path]); setDeleteSkippedCount(0); setDeleteOpen(true);
    }
  };

  const handleConfirmDelete = async () => {
    await deleteWithUndo(deletePaths);
    if (deleteSkippedCount > 0) toast.info(t('protectedFoldersSkipped', { count: deleteSkippedCount }));
    clearMultiSelect();
  };

  const multiSelectProtection = splitProtectedWorkspacePaths(multiSelectPaths);
  const isDeleteDisabled = (!selectedNode && multiSelectPaths.size === 0)
    || (isMultiSelectMode ? multiSelectProtection.allowedPaths.length === 0 : isProtectedDirectoryNode(selectedNode));

  const handleBulkMove = () => {
    if (multiSelectProtection.hasProtected) { toast.error(t('protectedFolderMove')); return; }
    setBulkMoveOpen(true);
  };

  const handleBulkDownload = async () => {
    for (const path of multiSelectPaths) {
      try { await downloadFile(path); } catch (error) { console.error(`Failed to download ${path}:`, error); }
    }
    toast.success(t('download'));
  };

  const handleBulkPublicShare = () => {
    const selectedPaths = Array.from(multiSelectPaths);
    if (selectedPaths.length === 0) return;
    setPublicSharePaths(selectedPaths);
    setPublicShareOpen(true);
  };

  const refreshPublishedPaths = useCallback(
    async (paths: string[]) => {
      const dirsToRefresh = Array.from(new Set(paths.map(getParentDirectory)));
      dirsToRefresh.sort((a, b) => {
        const depthDiff = a.split('/').length - b.split('/').length;
        return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
      });

      for (const dirPath of dirsToRefresh) {
        await refreshDirectory(dirPath, true);
      }
    },
    [refreshDirectory]
  );

  const navigateToDirectory = useCallback(
    async (targetDir: string) => {
      useFileStore.getState().setCurrentDirectory(targetDir);
      await refreshDirectory(targetDir, true);
    },
    [refreshDirectory]
  );

  const handleOpenFile = useCallback((path: string) => {
    void useFileStore.getState().revealAndLoadFile(path, { revealInTree: false })
      .then((result) => {
        if (result.status !== 'opened') {
          if (result.status !== 'superseded') toast.error(result.error);
          return;
        }

        notifyWorkspaceFileOpened(path, 'file-browser');
        handleFileOpened(path);
      });
  }, [handleFileOpened]);

  const pathParam = normalizeWorkspacePathParam(searchParams.get('path'));

  useEffect(() => {
    if (
      !isFullscreen
      || !pathParam
      || openedPathParamRef.current === pathParam
      || pendingPathParamRef.current === pathParam
    ) {
      return;
    }

    pendingPathParamRef.current = pathParam;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void revealAndLoadFile(pathParam)
        .then((result) => {
          if (cancelled) return;
          if (result.status !== 'opened') {
            if (result.status !== 'superseded') toast.error(result.error);
            return;
          }
          openedPathParamRef.current = pathParam;
          setActiveFilePath(pathParam);
          onFileSelect?.(pathParam);
        })
        .catch((error) => {
          if (!cancelled) {
            toast.error(error instanceof Error ? error.message : t('failedToLoadPreview'));
          }
        })
        .finally(() => {
          if (pendingPathParamRef.current === pathParam) {
            pendingPathParamRef.current = null;
          }
        });
    }, 0);

    return () => {
      cancelled = true;
      if (pendingPathParamRef.current === pathParam) {
        pendingPathParamRef.current = null;
      }
      window.clearTimeout(handle);
    };
  }, [isFullscreen, onFileSelect, pathParam, revealAndLoadFile, t]);

  const handleRefresh = useCallback(async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await refreshVisibleTree();
      invalidateFileReferenceValidationCache();

      const editorState = useEditorStore.getState();
      if (currentFile?.path && !editorState.isDirty && editorState.activePath === currentFile.path) {
        await refreshCurrentFileContent(currentFile.path);
      }
    } finally {
      setIsRefreshing(false);
    }
  }, [currentFile?.path, isRefreshing, refreshCurrentFileContent, refreshVisibleTree]);

  const handleZipExtracted = useCallback(async (targetDir: string, fileCount: number) => {
    await refreshDirectory(targetDir, true);
    invalidateFileReferenceValidationCache();
    toast.success(t('zipExtracted', { count: fileCount }));
  }, [refreshDirectory, t]);

  const toolbarHandlers: FileToolbarHandlers = {
    onToggleMultiSelect: toggleMultiSelectMode,
    onNewFile: handleNewFile,
    onNewExcalidraw: handleNewExcalidraw,
    onNewFolder: handleNewFolder,
    onUpload: handleUploadClick,
    onDelete: handleDeleteClick,
    onCollapseAll: collapseAllDirectories,
    onRefresh: handleRefresh,
  };

  const toolbarVariant = isFullscreen ? 'fullscreen' : isMobileSheet ? 'mobile-sheet' : 'sidebar';

  const mainContent = (
    <section
      style={!isFullscreen ? { width: '100%', minWidth: 0, flex: '1 1 0%' } : undefined}
      className={cn(
        'relative flex min-h-0 flex-1 flex-col overflow-hidden',
        isFullscreen ? 'h-full' : 'h-full w-full min-w-0',
        !isFullscreen && !isMobileSheet && 'overflow-y-auto bg-sidebar/50 md:border-r md:border-border',
        isMobileSheet && 'overflow-hidden bg-background',
        isDragging && 'bg-accent/50'
      )}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragStart={fileMoveDrag.handlers.onDragStart}
      onDragEnd={fileMoveDrag.handlers.onDragEnd}
      onPointerMove={fileMoveDrag.handlers.onPointerMove}
    >
      {isDragging && (
        <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center border-2 border-dashed border-border bg-background/95 text-sm text-foreground">
          {t('dropFilesToUpload')}
        </div>
      )}

      <div className={cn('sticky top-0 z-20 border-b border-border', isFullscreen ? 'bg-background' : 'bg-background/95')}>
        <FileToolbar
          variant={toolbarVariant}
          isMultiSelectMode={isMultiSelectMode}
          isDeleteDisabled={isDeleteDisabled}
          isRefreshing={isRefreshing}
          handlers={toolbarHandlers}
        />

        {isMultiSelectMode && (
          <div className={cn('flex items-center justify-between gap-2 border-t border-border bg-muted/40 text-xs', isFullscreen ? 'px-4 py-1.5' : 'px-3 py-1')}>
            <span className="text-muted-foreground">{t('selectedCount', { count: multiSelectPaths.size })}</span>
            <div className="flex items-center gap-1">
              {multiSelectPaths.size > 0 && (
                <>
                  <Button variant="ghost" size="icon-sm" onClick={handleBulkMove} disabled={multiSelectProtection.hasProtected} title={t('move')} aria-label={t('move')}>
                    <Move className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => void handleBulkDownload()} title={t('download')} aria-label={t('download')}>
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={handleBulkPublicShare} title={t('publicShareAction')} aria-label={t('publicShareAction')}>
                    <Globe2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={toggleMultiSelectMode}>
                <X className="mr-1 h-3 w-3" />
                {t('cancel')}
              </Button>
            </div>
          </div>
        )}

        <div className={cn('border-t border-border bg-muted/30', isFullscreen ? 'px-4 py-2' : 'px-3 py-2')}>
          <FileBreadcrumb
            currentDirectory={currentDirectory}
            dropTargetPath={fileMoveDrag.dropTargetPath}
            onNavigate={(dir) => {
              setSearchQuery('');
              void navigateToDirectory(dir);
            }}
          />
        </div>

        <div className={cn('border-t border-border', isFullscreen ? 'px-4 py-2' : 'px-3 py-2')}>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && searchQuery) setSearchQuery('');
              }}
              placeholder={t('searchFiles')}
              aria-label={t('searchFiles')}
              className="h-9 bg-background pl-8 pr-9 placeholder:text-muted-foreground"
            />
            {searchQuery && (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute right-1 top-0.5 h-8 w-8 text-muted-foreground hover:text-foreground"
                onClick={() => setSearchQuery('')}
                aria-label={t('clearSearch')}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          {uploadProgress !== null && (
            <UploadProgress value={uploadProgress} className="mt-2" />
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <FileGridView
          variant={variant}
          onOpenFile={handleOpenFile}
          onFileOpened={handleFileOpened}
          onUpload={handleUploadClick}
          onCreateFolder={handleNewFolder}
          moveController={moveController}
          dropTargetPath={fileMoveDrag.dropTargetPath}
        />
      </div>

      <CreateItemDialog {...createDialogProps} defaultPath={resolveTargetDir()} />
      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} defaultPath={resolveTargetDir()} onUpload={handleUpload} />
      <DeleteConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} paths={deletePaths} skippedCount={deleteSkippedCount} onConfirm={handleConfirmDelete} />
      <PublicShareDialog
        open={publicShareOpen}
        onOpenChange={setPublicShareOpen}
        paths={publicSharePaths}
        onPublished={() => void refreshPublishedPaths(publicSharePaths)}
      />
      <ImagePreprocessDialog open={imagePreprocess.dialogState !== null} onOpenChange={(open) => { if (!open) imagePreprocess.setDialogState(null); }} files={imagePreprocess.dialogState?.files ?? []} onConfirm={imagePreprocess.handleConfirm} onSkip={imagePreprocess.handleSkip} isProcessing={imagePreprocess.isProcessing} progressItems={imagePreprocess.progressItems} />

      {isFullscreen && (
        <FilePreviewDialog
          path={activeFilePath}
          fileTree={fileTree}
          currentDirectory={currentDirectory}
          onClose={() => setActiveFilePath(null)}
          onZipExtracted={handleZipExtracted}
        />
      )}
    </section>
  );

  if (!isFullscreen) {
    return mainContent;
  }

  return (
    <div className="flex h-[100dvh] flex-col bg-background text-foreground">
      <header className="z-40 h-16 flex-shrink-0 border-b border-border bg-background/95 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-full items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" className="gap-2 px-2 sm:px-3">
              <Link href="/">
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">{tCommon('suite')}</span>
              </Link>
            </Button>
            <h1 className="hidden md:block text-lg md:text-2xl font-bold truncate">{t('filesTitle')}</h1>
          </div>
          <div className="flex items-center gap-1.5 md:gap-4">
            <WorkspaceSwitcher source="navbar" variant="compact" />
            <NotificationBell />
            <AppLauncher />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {mainContent}
      </div>
    </div>
  );
}
