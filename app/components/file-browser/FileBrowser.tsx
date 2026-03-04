'use client';

import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { ChevronsDownUp, FilePlus, FolderPlus, RefreshCw, Search, Upload, CheckSquare, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
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

export function FileBrowser() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounter = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
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
      const pathsToDelete = Array.from(multiSelectPaths);
      if (pathsToDelete.length === 0) return;
      
      const confirmed = window.confirm(`Are you sure you want to delete ${pathsToDelete.length} items?`);
      if (confirmed) {
        await deletePath(pathsToDelete);
        clearMultiSelect();
      }
    } else if (selectedNode) {
      const confirmed = window.confirm(`Are you sure you want to delete "${selectedNode.name}"?`);
      if (confirmed) {
        await deletePath(selectedNode.path);
      }
    }
  };

  return (
    <section
      className={cn(
        'relative flex h-full flex-col border-r border-border bg-sidebar/50 overflow-y-auto',
        isDragging && 'bg-accent/50'
      )}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded border-2 border-dashed border-border bg-background/90 text-sm text-foreground">
          Drop files to upload
        </div>
      )}
      <div className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
        <div className="flex items-center justify-between px-3 py-2">
          <h2 className="text-sm font-semibold text-foreground">Files</h2>
          <TooltipProvider delayDuration={300}>
            <div className="flex flex-wrap items-center justify-end gap-1">
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
                    disabled={!selectedNode && multiSelectPaths.length === 0}
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
                    onClick={async () => {
                      useFileStore.getState().setCurrentDirectory('.');
                      await loadFileTree('.', undefined, true);
                      const { currentFile } = useFileStore.getState();
                      if (currentFile) {
                        useFileStore.getState().loadFile(currentFile.path, true);
                      }
                    }}
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
            </div>
          </TooltipProvider>
        </div>
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
            <div className="mt-2 h-1 w-full overflow-hidden rounded bg-muted">
              <div
                className="h-full bg-sky-500 transition-all"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <FileTree />
      </div>
    </section>
  );
}
