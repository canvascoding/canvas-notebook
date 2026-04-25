'use client';

import { useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { FileEditor } from '@/app/components/editor/FileEditor';
import { useFileStore, type FileNode } from '@/app/store/file-store';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);

function getExtension(path: string) {
  const parts = path.split('.');
  if (parts.length <= 1) return '';
  return parts[parts.length - 1].toLowerCase();
}

function flattenDirectoryImages(nodes: FileNode[], dirPath: string): string[] {
  const isImagePath = (filePath: string) => IMAGE_EXTENSIONS.has(getExtension(filePath));

  if (dirPath === '.') {
    return nodes
      .filter((node) => node.type === 'file' && isImagePath(node.path))
      .map((node) => node.path);
  }

  for (const node of nodes) {
    if (node.path === dirPath) {
      return (node.children ?? [])
        .filter((child) => child.type === 'file' && isImagePath(child.path))
        .map((child) => child.path);
    }
    if (node.children) {
      const nestedImages = flattenDirectoryImages(node.children, dirPath);
      if (nestedImages.length > 0) {
        return nestedImages;
      }
    }
  }

  return [];
}

interface FilePreviewDialogProps {
  path: string | null;
  fileTree: FileNode[];
  currentDirectory: string;
  onClose: () => void;
}

export function FilePreviewDialog({ path, fileTree, currentDirectory, onClose }: FilePreviewDialogProps) {
  const t = useTranslations('notebook');
  const { currentFile, loadFile, downloadFile, clearCurrentFile } = useFileStore();

  useEffect(() => {
    if (!path) return;
    void loadFile(path, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to path changes
  }, [path]);

  const imagePaths = useMemo(
    () => flattenDirectoryImages(fileTree, currentDirectory),
    [currentDirectory, fileTree]
  );

  const activePath = currentFile?.path ?? path;
  const currentIndex = activePath ? imagePaths.indexOf(activePath) : -1;
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < imagePaths.length - 1;

  const handleClose = useCallback(() => {
    clearCurrentFile();
    onClose();
  }, [clearCurrentFile, onClose]);

  const handlePrev = useCallback(() => {
    if (currentIndex <= 0) return;
    void loadFile(imagePaths[currentIndex - 1], true);
  }, [currentIndex, imagePaths, loadFile]);

  const handleNext = useCallback(() => {
    if (currentIndex < 0 || currentIndex >= imagePaths.length - 1) return;
    void loadFile(imagePaths[currentIndex + 1], true);
  }, [currentIndex, imagePaths, loadFile]);

  useEffect(() => {
    if (!path) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        handlePrev();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        handleNext();
      } else if (event.key === 'Escape') {
        handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [path, handlePrev, handleNext, handleClose]);

  if (!path) return null;

  const displayPath = activePath ?? path;
  const fileName = displayPath.split('/').pop() || displayPath;

  return (
    <Dialog open={!!path} onOpenChange={(open) => { if (!open) handleClose(); }}>
      <DialogContent layout="viewport" showCloseButton={false} className="flex h-full flex-col gap-0 p-0">
        <DialogTitle className="sr-only">{fileName}</DialogTitle>
        <DialogDescription className="sr-only">File editor: {fileName}</DialogDescription>

        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{fileName}</p>
            {currentIndex >= 0 && imagePaths.length > 1 && (
              <p className="text-xs text-muted-foreground">{currentIndex + 1} / {imagePaths.length}</p>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void downloadFile(displayPath)}
              aria-label={t('download')}
            >
              <Download className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={handleClose} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <FileEditor />

          {imagePaths.length > 1 && currentIndex >= 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full border border-border bg-background/90 shadow-sm backdrop-blur disabled:opacity-40"
              onClick={handlePrev}
              disabled={!hasPrev}
              aria-label={t('previous')}
            >
              <ChevronLeft className="h-5 w-5" />
            </Button>
          )}

          {imagePaths.length > 1 && currentIndex >= 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full border border-border bg-background/90 shadow-sm backdrop-blur disabled:opacity-40"
              onClick={handleNext}
              disabled={!hasNext}
              aria-label={t('next')}
            >
              <ChevronRight className="h-5 w-5" />
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
