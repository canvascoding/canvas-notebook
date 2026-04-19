'use client';

import { useState, useCallback, useEffect, type DragEvent } from 'react';
import Image from 'next/image';
import { ArrowLeft, CheckSquare, ChevronsDownUp, FilePlus, FolderPlus, FolderTree, List, LayoutGrid, MoreHorizontal, Move, Search, Trash2, Upload, X } from 'lucide-react';
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
import { useFileStore, findPathInTree, type BrowserMode } from '@/app/store/file-store';
import { FileBreadcrumb } from '@/app/components/file-browser/FileBreadcrumb';
import { CreateItemDialog } from '@/app/components/file-browser/CreateItemDialog';
import { UploadDialog } from '@/app/components/file-browser/UploadDialog';
import { DeleteConfirmDialog } from '@/app/components/file-browser/DeleteConfirmDialog';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { useFileWatcher } from '@/app/hooks/useFileWatcher';
import { useImagePreprocess } from '@/app/hooks/useImagePreprocess';
import { ImagePreprocessDialog } from '@/app/components/shared/ImagePreprocessDialog';
import { getDroppedFiles } from '@/app/lib/drop-traverse';
import { FileGridView } from './FileGridView';
import { ImagePreviewDialog } from './ImagePreviewDialog';
import { Link } from '@/i18n/navigation';

export type FilesViewMode = 'grid' | 'list' | 'tree';

export function FilesContainer() {
  const t = useTranslations('notebook');
  const dragCounter = useState(0);
  const dragCounterRef = dragCounter[0];
  const setDragCounter = dragCounter[1];
  const [isDragging, setIsDragging] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<'file' | 'directory'>('file');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePaths, setDeletePaths] = useState<string[]>([]);
  const [deleteSkippedCount, setDeleteSkippedCount] = useState(0);
  const [viewMode, setViewMode] = useState<FilesViewMode>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('canvas-files-view-mode') as FilesViewMode) || 'grid';
    }
    return 'grid';
  });
  const [previewPath, setPreviewPath] = useState<string | null>(null);

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
    browserMode,
    setBrowserMode,
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
      const dir = targetDir ?? resolveTargetDir();
      await uploadFile(files, dir, pathMap, convertParams);
    },
  });

  useEffect(() => {
    if (currentDirectory && currentDirectory !== '.' && !isDirectoryReachableInTree(currentDirectory)) {
      useFileStore.getState().setCurrentDirectory('.');
    }
  }, [currentDirectory, isDirectoryReachableInTree]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('canvas-files-view-mode', viewMode);
    }
  }, [viewMode]);

  useEffect(() => {
    if (viewMode === 'list') {
      setBrowserMode('list');
    } else {
      setBrowserMode('tree');
    }
  }, [viewMode, setBrowserMode]);

  const resolveTargetDir = () => {
    if (!selectedNode) return '.';
    if (currentDirectory && currentDirectory !== '.' && isDirectoryReachableInTree(currentDirectory)) {
      return currentDirectory;
    }
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
    setDragCounter((c) => c + 1);
    setIsDragging(true);
  };
  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragCounter((c) => {
      const next = c - 1;
      if (next <= 0) { setIsDragging(false); return 0; }
      return next;
    });
  };
  const handleDragOver = (event: DragEvent<HTMLElement>) => { event.preventDefault(); };
  const handleDrop = async (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragCounter(0);
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

  return (
    <div className="flex h-[100dvh] flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <div className="mx-auto flex min-h-14 max-w-7xl items-center justify-between gap-3 px-4 py-2 md:px-6">
          <div className="min-w-0 flex items-center gap-3">
            <Button asChild variant="ghost" size="sm" className="gap-1.5 px-2">
              <Link href="/">
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">{t('home')}</span>
              </Link>
            </Button>
            <Image src="/logo.jpg" alt="Canvas Notebook" width={28} height={28} className="shrink-0 border border-border" />
            <h1 className="truncate text-sm font-semibold md:text-lg">{t('filesTitle')}</h1>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          className="relative flex flex-1 flex-col overflow-hidden"
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

          <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-background/95 px-3 py-2">
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={toggleMultiSelectMode}
                    aria-label={t('toggleSelectMode')}
                  >
                    <CheckSquare className={cn('h-4 w-4', isMultiSelectMode && 'text-primary')} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t('select')}</TooltipContent>
              </Tooltip>

              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleNewFile}
                aria-label={t('newFile')}
              >
                <FilePlus className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleNewFolder}
                aria-label={t('newFolder')}
              >
                <FolderPlus className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleUploadClick}
                aria-label={t('upload')}
              >
                <Upload className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={handleDeleteClick}
                disabled={isDeleteDisabled}
                aria-label={t('delete')}
              >
                <Trash2 className="h-4 w-4" />
              </Button>

              <div className="hidden h-5 w-px bg-border sm:block" />

              <div className="flex items-center rounded-md border border-border p-0.5">
                {(['grid', 'list', 'tree'] as FilesViewMode[]).map((mode) => (
                  <Button
                    key={mode}
                    variant={viewMode === mode ? 'secondary' : 'ghost'}
                    size="icon-sm"
                    className="h-6 w-6 rounded-sm"
                    onClick={() => setViewMode(mode)}
                    aria-label={mode === 'grid' ? t('browserModeGrid') : mode === 'list' ? t('browserModeList') : t('browserModeTree')}
                  >
                    {mode === 'grid' && <LayoutGrid className="h-3.5 w-3.5" />}
                    {mode === 'list' && <List className="h-3.5 w-3.5" />}
                    {mode === 'tree' && <FolderTree className="h-3.5 w-3.5" />}
                  </Button>
                ))}
              </div>

              {viewMode === 'tree' && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={collapseAllDirectories}
                  aria-label={t('collapseAllFolders')}
                >
                  <ChevronsDownUp className="h-4 w-4" />
                </Button>
              )}
            </TooltipProvider>
          </div>

          {isMultiSelectMode && (
            <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-1 text-xs">
              <span className="text-muted-foreground">{t('selectedCount', { count: multiSelectPaths.size })}</span>
              <div className="flex items-center gap-1">
                {multiSelectPaths.size > 0 && (
                  <>
                    <Button variant="ghost" size="icon-sm" onClick={handleBulkMove} disabled={hasProtectedSelected} title={t('move')}>
                      <Move className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => void handleBulkDownload()} title={t('download')}>
                      <X className="h-3.5 w-3.5" />
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

          <div className="border-b border-border bg-muted/30 px-3 py-2">
            <FileBreadcrumb currentDirectory={currentDirectory} onNavigate={(dir) => void navigateToDirectory(dir)} />
          </div>

          <div className="border-b border-border px-3 py-2">
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

          <div className="min-h-0 flex-1 overflow-hidden">
            <FileGridView
              viewMode={viewMode}
              onPreviewImage={setPreviewPath}
            />
          </div>
        </div>
      </div>

      <CreateItemDialog open={createOpen} onOpenChange={setCreateOpen} type={createType} defaultPath={resolveTargetDir()} onCreate={handleCreate} />
      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} defaultPath={resolveTargetDir()} onUpload={handleUpload} />
      <DeleteConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} paths={deletePaths} skippedCount={deleteSkippedCount} onConfirm={handleConfirmDelete} />
      <ImagePreprocessDialog open={imagePreprocess.dialogState !== null} onOpenChange={(open) => { if (!open) imagePreprocess.setDialogState(null); }} files={imagePreprocess.dialogState?.files ?? []} onConfirm={imagePreprocess.handleConfirm} onSkip={imagePreprocess.handleSkip} />
      <ImagePreviewDialog
        path={previewPath}
        fileTree={fileTree}
        currentDirectory={currentDirectory}
        onClose={() => setPreviewPath(null)}
      />
    </div>
  );
}