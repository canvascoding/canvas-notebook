'use client';

import { useEffect, useMemo, useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Archive, Download, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { FileEditor } from '@/app/components/editor/FileEditor';
import { useFileStore } from '@/app/store/file-store';
import type { FileNode } from '@/app/lib/files/types';
import { isExcalidrawFilePath } from '@/app/lib/excalidraw-file';
import { extractWorkspaceZip } from '@/app/lib/files/client';

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
  onZipExtracted?: (targetDir: string, fileCount: number) => Promise<void>;
}

export function FilePreviewDialog({
  path,
  fileTree,
  currentDirectory,
  onClose,
  onZipExtracted,
}: FilePreviewDialogProps) {
  const t = useTranslations('notebook');
  const { currentFile, isLoadingFile, loadingFilePath, loadFile, downloadFile } = useFileStore();
  const [isExtracting, setIsExtracting] = useState(false);
  const isZipArchive = path ? getExtension(path) === 'zip' : false;

  useEffect(() => {
    if (!path || isZipArchive) return;
    const state = useFileStore.getState();
    if (state.currentFile?.path === path || (state.isLoadingFile && state.loadingFilePath === path)) return;
    void loadFile(path, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to path changes
  }, [path, isZipArchive]);

  const imagePaths = useMemo(
    () => flattenDirectoryImages(fileTree, currentDirectory),
    [currentDirectory, fileTree]
  );

  const activePath = isLoadingFile && loadingFilePath ? loadingFilePath : currentFile?.path ?? path;
  const isActiveExcalidraw = activePath ? isExcalidrawFilePath(activePath) : false;
  const currentIndex = activePath ? imagePaths.indexOf(activePath) : -1;

  const handleClose = useCallback(async () => {
    if (!activePath) { onClose(); return; }
    try {
      if (await useFileStore.getState().closeFile(activePath)) onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failedToSaveFile'));
    }
  }, [activePath, onClose, t]);

  const handleExtractZip = useCallback(async () => {
    if (!path || isExtracting) return;

    setIsExtracting(true);
    try {
      const result = await extractWorkspaceZip(path, currentDirectory);
      await onZipExtracted?.(result.targetDir, result.files.length);
      handleClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('zipExtractFailed'));
    } finally {
      setIsExtracting(false);
    }
  }, [currentDirectory, handleClose, isExtracting, onZipExtracted, path, t]);

  useEffect(() => {
    if (!path) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isActiveExcalidraw && event.key === 'Escape') {
        handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [path, isActiveExcalidraw, handleClose]);

  if (!path) return null;

  const displayPath = activePath ?? path;
  const fileName = displayPath.split('/').pop() || displayPath;

  return (
    <Dialog open={!!path} onOpenChange={(open) => { if (!open) handleClose(); }}>
      <DialogContent
        layout="viewport"
        showCloseButton={false}
        className="flex h-full flex-col gap-0 p-0"
        onEscapeKeyDown={(event) => {
          if (isActiveExcalidraw) event.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">{fileName}</DialogTitle>
        <DialogDescription className="sr-only">{t('fileEditorDescription', { name: fileName })}</DialogDescription>

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
            <Button variant="ghost" size="icon-sm" onClick={handleClose} aria-label={t('close')}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          {isZipArchive ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                <Archive className="h-8 w-8" aria-hidden="true" />
              </div>
              <h2 className="text-lg font-semibold">{t('zipPreviewTitle')}</h2>
              <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                {t('zipPreviewDescription', { directory: currentDirectory === '.' ? t('workspaceRoot') : currentDirectory })}
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                <Button variant="outline" onClick={handleClose} disabled={isExtracting}>
                  {t('cancel')}
                </Button>
                <Button onClick={() => void handleExtractZip()} disabled={isExtracting}>
                  {isExtracting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
                  {t('zipExtractHere')}
                </Button>
              </div>
            </div>
          ) : (
            <FileEditor />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
