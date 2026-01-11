'use client';

import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { ChevronsDownUp, FilePlus, FolderPlus, RefreshCw, Search, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useFileStore } from '@/app/store/file-store';
import { FileTree } from './FileTree';

export function FileBrowser() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounter = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const {
    isLoadingTree,
    loadFileTree,
    selectedNode,
    createPath,
    uploadFile,
    uploadProgress,
    currentDirectory,
    searchQuery,
    setSearchQuery,
    collapseAllDirectories,
  } = useFileStore();

  const resolveTargetDir = () => {
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

  return (
    <section
      className={cn(
        'relative flex h-full flex-col border-r border-slate-700 bg-slate-800/30 overflow-y-auto',
        isDragging && 'bg-slate-800/60'
      )}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded border-2 border-dashed border-slate-400 bg-slate-950/70 text-sm text-slate-200">
          Drop files to upload
        </div>
      )}
      <div className="sticky top-0 z-20 border-b border-slate-700 bg-slate-800/90 backdrop-blur">
        <div className="flex items-center justify-between px-3 py-2">
          <h2 className="text-sm font-semibold text-slate-200">Files</h2>
          <TooltipProvider delayDuration={300}>
            <div className="flex items-center gap-1">
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
                    onClick={() => loadFileTree()}
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
            </div>
          </TooltipProvider>
        </div>
        <div className="border-t border-slate-700 px-3 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-slate-500" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search files"
              className="h-9 bg-slate-900 pl-8 text-slate-200 placeholder:text-slate-500"
            />
          </div>
          {uploadProgress !== null && (
            <div className="mt-2 h-1 w-full overflow-hidden rounded bg-slate-800">
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
