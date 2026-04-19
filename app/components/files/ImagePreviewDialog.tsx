'use client';

import { useState, useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Download, X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useFileStore, type FileNode } from '@/app/store/file-store';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'heif']);

function collectImagePaths(nodes: FileNode[]): string[] {
  const result: string[] = [];
  const traverse = (items: FileNode[]) => {
    for (const node of items) {
      if (node.type === 'file') {
        const ext = node.name.split('.').pop()?.toLowerCase() || '';
        if (IMAGE_EXTENSIONS.has(ext)) result.push(node.path);
      }
      if (node.children) traverse(node.children);
    }
  };
  traverse(nodes);
  return result;
}

function getDirectoryName(path: string): string {
  if (path === '.') return '.';
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash <= 0) return '.';
  return path.slice(0, lastSlash);
}

interface ImagePreviewDialogProps {
  path: string | null;
  fileTree: FileNode[];
  currentDirectory: string;
  onClose: () => void;
}

export function ImagePreviewDialog({ path, fileTree, currentDirectory, onClose }: ImagePreviewDialogProps) {
  const t = useTranslations('notebook');
  const [zoom, setZoom] = useState(1);
  const [hasError, setHasError] = useState(false);
  const [currentSrc, setCurrentSrc] = useState<string | null>(null);

  const downloadFile = useFileStore((s) => s.downloadFile);

  const imagesInDir = collectImagePaths(fileTree);
  const currentIndex = path ? imagesInDir.indexOf(path) : -1;
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < imagesInDir.length - 1;

  useEffect(() => {
    if (path) {
      const previewSrc = toPreviewUrl(path, 1280);
      setCurrentSrc(previewSrc);
      setHasError(false);
      setZoom(1);
    }
  }, [path]);

  const handlePrev = useCallback(() => {
    if (hasPrev) {
      const prevPath = imagesInDir[currentIndex - 1];
      const previewSrc = toPreviewUrl(prevPath, 1280);
      setCurrentSrc(previewSrc);
      setHasError(false);
      setZoom(1);
    }
  }, [hasPrev, currentIndex, imagesInDir]);

  const handleNext = useCallback(() => {
    if (hasNext) {
      const nextPath = imagesInDir[currentIndex + 1];
      const previewSrc = toPreviewUrl(nextPath, 1280);
      setCurrentSrc(previewSrc);
      setHasError(false);
      setZoom(1);
    }
  }, [hasNext, currentIndex, imagesInDir]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!path) return;
      if (event.key === 'ArrowLeft') handlePrev();
      if (event.key === 'ArrowRight') handleNext();
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [path, handlePrev, handleNext, onClose]);

  if (!path) return null;

  const fileName = path.split('/').pop() || path;
  const fullSrc = toMediaUrl(path);

  const handleError = () => {
    if (currentSrc !== fullSrc) {
      setCurrentSrc(fullSrc);
    } else {
      setHasError(true);
    }
  };

  const handleDownload = () => { void downloadFile(path); };

  return (
    <Dialog open={!!path} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex h-[90vh] max-w-[95vw] flex-col gap-0 p-0 sm:max-w-[90vw] [&>button]:hidden">
        <DialogTitle className="sr-only">{fileName}</DialogTitle>
        <DialogDescription className="sr-only">Image preview: {fileName}</DialogDescription>

        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{fileName}</p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {currentIndex >= 0 && imagesInDir.length > 1 && (
                <span>{currentIndex + 1} / {imagesInDir.length}</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" onClick={() => setZoom((z) => Math.min(z + 0.5, 5))} aria-label="Zoom in">
              <ZoomIn className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => setZoom((z) => Math.max(z - 0.25, 0.25))} aria-label="Zoom out">
              <ZoomOut className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={handleDownload} aria-label={t('download')}>
              <Download className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-black/5">
          {hasError ? (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <p className="text-sm">Failed to load image</p>
              <Button variant="outline" size="sm" onClick={handleDownload}>Download file</Button>
            </div>
          ) : currentSrc ? (
            <img
              src={currentSrc}
              alt={fileName}
              className="max-h-full max-w-full object-contain transition-transform duration-200"
              style={{ transform: `scale(${zoom})` }}
              onError={handleError}
              draggable={false}
            />
          ) : null}

          {imagesInDir.length > 1 && hasPrev && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute left-2 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-background/80 shadow-md hover:bg-background"
              onClick={handlePrev}
              aria-label="Previous image"
            >
              <ChevronLeft className="h-5 w-5" />
            </Button>
          )}
          {imagesInDir.length > 1 && hasNext && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-2 top-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-background/80 shadow-md hover:bg-background"
              onClick={handleNext}
              aria-label="Next image"
            >
              <ChevronRight className="h-5 w-5" />
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}