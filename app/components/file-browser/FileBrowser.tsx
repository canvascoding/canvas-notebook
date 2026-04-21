'use client';

import { useRef, useState, useCallback, useEffect, type DragEvent } from 'react';
import { ArrowLeft, Download, Move, Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useFileStore, findPathInTree } from '@/app/store/file-store';
import { FileGridView } from './FileGridView';
import { FileToolbar, type FileToolbarHandlers } from './FileToolbar';
import { FileBreadcrumb } from './FileBreadcrumb';
import { CreateItemDialog } from './CreateItemDialog';
import { UploadDialog } from './UploadDialog';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { useFileWatcher } from '@/app/hooks/useFileWatcher';
import { useImagePreprocess } from '@/app/hooks/useImagePreprocess';
import { ImagePreprocessDialog } from '@/app/components/shared/ImagePreprocessDialog';
import { getDroppedFiles } from '@/app/lib/drop-traverse';
import { FilePreviewDialog } from '@/app/components/files/FilePreviewDialog';
import { Link } from '@/i18n/navigation';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { LogoutButton } from '@/app/components/LogoutButton';
import { NotebookNavButton } from '@/app/components/NotebookNavButton';

interface FileBrowserProps {
  variant?: 'default' | 'mobile-sheet' | 'fullscreen';
  onFileSelect?: (path: string) => void;
}

export function FileBrowser({ variant = 'default', onFileSelect }: FileBrowserProps) {
  const t = useTranslations('notebook');
  const tCommon = useTranslations('common');
  const dragCounter = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<'file' | 'directory'>('file');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePaths, setDeletePaths] = useState<string[]>([]);
  const [deleteSkippedCount, setDeleteSkippedCount] = useState(0);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);

  const isFullscreen = variant === 'fullscreen';
  const isMobileSheet = variant === 'mobile-sheet';

  useFileWatcher({
    enabled: true,
    debounceMs: 1000,
    maxDebounceMs: 5000,
  });

  const {
    refreshDirectory,
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
    setBulkMoveOpen,
  } = useFileStore();

  const isDirectoryReachableInTree = useCallback(
    (dirPath: string) => {
      if (dirPath === '.') return true;
      if (findPathInTree(dirPath, fileTree)) return true;
      const [rootSegment] = dirPath.split('/');
      return fileTree.some((node) => node.type === 'directory' && node.path === rootSegment);
    },
    [fileTree]
  );

  const imagePreprocess = useImagePreprocess({
    onUpload: async (files, convertParams, targetDir, pathMap) => {
      const dir = targetDir || resolveTargetDir();
      await uploadFile(files, dir, pathMap, convertParams);
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

  const handleNewFile = () => { setCreateType('file'); setCreateOpen(true); };
  const handleNewFolder = () => { setCreateType('directory'); setCreateOpen(true); };
  const handleCreate = async (fullPath: string, itemType: 'file' | 'directory') => { await createPath(fullPath, itemType); };
  const handleUploadClick = () => { setUploadOpen(true); };
  const handleUpload = async (files: File[], targetDir: string) => { await imagePreprocess.handleFiles(files, targetDir); };

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragCounter.current += 1;
    setIsDragging(true);
  };
  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) { dragCounter.current = 0; setIsDragging(false); }
  };
  const handleDragOver = (event: DragEvent<HTMLElement>) => { event.preventDefault(); };
  const handleDrop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    dragCounter.current = 0;
    setIsDragging(false);
    const dropped = await getDroppedFiles(event.dataTransfer);
    if (dropped.length === 0) return;
    const files = dropped.map((d) => d.file);
    const pathMap = new Map<File, string>();
    for (const d of dropped) { pathMap.set(d.file, d.relativePath); }
    const targetDir = resolveTargetDir();
    await imagePreprocess.handleFiles(files, targetDir, pathMap);
  };

  const handleDeleteClick = () => {
    if (isMultiSelectMode) {
      const pathsToDelete = Array.from(multiSelectPaths).filter((path) => !isProtectedAppOutputFolder(path));
      const skippedCount = multiSelectPaths.size - pathsToDelete.length;
      if (pathsToDelete.length === 0) {
        if (skippedCount > 0) toast.error(t('protectedFoldersDeleteOnly'));
        return;
      }
      setDeletePaths(pathsToDelete); setDeleteSkippedCount(skippedCount); setDeleteOpen(true);
    } else if (selectedNode) {
      if (selectedNode.type === 'directory' && isProtectedAppOutputFolder(selectedNode.path)) {
        toast.error(t('protectedFolderDelete')); return;
      }
      setDeletePaths([selectedNode.path]); setDeleteSkippedCount(0); setDeleteOpen(true);
    }
  };

  const handleConfirmDelete = async () => {
    await deletePath(deletePaths);
    if (deleteSkippedCount > 0) toast.info(t('protectedFoldersSkipped', { count: deleteSkippedCount }));
    clearMultiSelect();
  };

  const deletableMultiSelectCount = Array.from(multiSelectPaths).filter((path) => !isProtectedAppOutputFolder(path)).length;
  const hasProtectedSelected = Array.from(multiSelectPaths).some(path => isProtectedAppOutputFolder(path));
  const isDeleteDisabled = (!selectedNode && multiSelectPaths.size === 0) || (isMultiSelectMode ? deletableMultiSelectCount === 0 : selectedNode?.type === 'directory' && isProtectedAppOutputFolder(selectedNode.path));

  const handleBulkMove = () => {
    if (hasProtectedSelected) { toast.error(t('protectedFolderMove')); return; }
    setBulkMoveOpen(true);
  };

  const handleBulkDownload = async () => {
    for (const path of multiSelectPaths) {
      try { await downloadFile(path); } catch (error) { console.error(`Failed to download ${path}:`, error); }
    }
    toast.success(t('download'));
  };

  const navigateToDirectory = useCallback(
    async (targetDir: string) => {
      useFileStore.getState().setCurrentDirectory(targetDir);
      await refreshDirectory(targetDir, true);
    },
    [refreshDirectory]
  );

  const handleOpenFile = useCallback((path: string) => {
    if (isFullscreen) {
      setActiveFilePath(path);
    } else {
      void useFileStore.getState().loadFile(path, true);
    }
    onFileSelect?.(path);
  }, [isFullscreen, onFileSelect]);

  const toolbarHandlers: FileToolbarHandlers = {
    onToggleMultiSelect: toggleMultiSelectMode,
    onNewFile: handleNewFile,
    onNewFolder: handleNewFolder,
    onUpload: handleUploadClick,
    onDelete: handleDeleteClick,
    onCollapseAll: collapseAllDirectories,
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
          handlers={toolbarHandlers}
        />

        {isMultiSelectMode && (
          <div className={cn('flex items-center justify-between gap-2 border-t border-border bg-muted/40 text-xs', isFullscreen ? 'px-4 py-1.5' : 'px-3 py-1')}>
            <span className="text-muted-foreground">{t('selectedCount', { count: multiSelectPaths.size })}</span>
            <div className="flex items-center gap-1">
              {multiSelectPaths.size > 0 && (
                <>
                  <Button variant="ghost" size="icon-sm" onClick={handleBulkMove} disabled={hasProtectedSelected} title={t('move')}>
                    <Move className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => void handleBulkDownload()} title={t('download')}>
                    <Download className="h-3.5 w-3.5" />
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
          <FileBreadcrumb currentDirectory={currentDirectory} onNavigate={(dir) => void navigateToDirectory(dir)} />
        </div>

        <div className={cn('border-t border-border', isFullscreen ? 'px-4 py-2' : 'px-3 py-2')}>
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
              <div className="h-full bg-primary transition-all" style={{ width: `${uploadProgress}%` }} />
            </div>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <FileGridView variant={variant} onOpenFile={handleOpenFile} />
      </div>

      <CreateItemDialog open={createOpen} onOpenChange={setCreateOpen} type={createType} defaultPath={resolveTargetDir()} onCreate={handleCreate} />
      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} defaultPath={resolveTargetDir()} onUpload={handleUpload} />
      <DeleteConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} paths={deletePaths} skippedCount={deleteSkippedCount} onConfirm={handleConfirmDelete} />
      <ImagePreprocessDialog open={imagePreprocess.dialogState !== null} onOpenChange={(open) => { if (!open) imagePreprocess.setDialogState(null); }} files={imagePreprocess.dialogState?.files ?? []} onConfirm={imagePreprocess.handleConfirm} onSkip={imagePreprocess.handleSkip} />

      {isFullscreen && (
        <FilePreviewDialog
          path={activeFilePath}
          fileTree={fileTree}
          currentDirectory={currentDirectory}
          onClose={() => setActiveFilePath(null)}
        />
      )}
    </section>
  );

  if (!isFullscreen) {
    return mainContent;
  }

  return (
    <div className="flex h-[100dvh] flex-col bg-background text-foreground">
      <header className="z-40 h-16 flex-shrink-0 border-b border-border bg-background/95">
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
            <NotebookNavButton />
            <ThemeToggle />

            <LogoutButton />
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {mainContent}
      </div>
    </div>
  );
}