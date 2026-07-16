'use client';

import { useRef, useState, useEffect } from 'react';
import { Upload, FolderPlus, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useFileStore } from '@/app/store/file-store';
import { DirectoryBrowser } from './DirectoryBrowser';
import { UploadProgress } from './UploadProgress';

interface UploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultPath: string;
  onUpload: (files: File[], targetDir: string) => Promise<void>;
}

export function UploadDialog({ open, onOpenChange, defaultPath, onUpload }: UploadDialogProps) {
  const t = useTranslations('notebook');
  const fileTree = useFileStore((state) => state.fileTree);
  const uploadProgress = useFileStore((state) => state.uploadProgress);
  const uploadItems = useFileStore((state) => state.uploadItems);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [targetDir, setTargetDir] = useState(defaultPath);
  const [expandedDirs, setExpandedDirs] = useState(new Set<string>());
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setTargetDir(defaultPath);
      setExpandedDirs(new Set());
      setIsUploading(false);
      setError('');
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [open, defaultPath]);

  const toggleDir = (path: string) => {
    setExpandedDirs(prev => {
      const newSet = new Set(prev);
      if (newSet.has(path)) {
        newSet.delete(path);
      } else {
        newSet.add(path);
      }
      return newSet;
    });
  };

  const handleFileInputChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    await performUpload(files);
    event.target.value = '';
  };

  const performUpload = async (files: File[]) => {
    setIsUploading(true);
    setError('');
    try {
      await onUpload(files, targetDir);
      onOpenChange(false);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : t('uploadFailed'));
    } finally {
      setIsUploading(false);
    }
  };

  const handleSelectFiles = () => {
    fileInputRef.current?.click();
  };

  const handleSelectFolder = () => {
    folderInputRef.current?.click();
  };

  const visibleProgress = uploadProgress ?? (() => {
    if (uploadItems.length === 0) return 0;
    const totalBytes = uploadItems.reduce((total, item) => total + item.size, 0);
    const uploadedBytes = uploadItems.reduce((total, item) => total + item.uploadedBytes, 0);
    return totalBytes > 0
      ? Math.round((uploadedBytes / totalBytes) * 100)
      : Math.round((uploadItems.filter((item) => item.status === 'completed').length / uploadItems.length) * 100);
  })();

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isUploading || nextOpen) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('uploadTitle')}</DialogTitle>
          <DialogDescription>{t('uploadDescription')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label htmlFor="uploadTargetDir" className="text-xs text-muted-foreground">{t('uploadTo')}</label>
            <Input
              id="uploadTargetDir"
              value={targetDir}
              onChange={(e) => setTargetDir(e.target.value)}
              className="mt-1"
              disabled={isUploading}
            />
          </div>
          <div className={isUploading ? 'pointer-events-none opacity-60' : undefined}>
            <DirectoryBrowser
              tree={fileTree}
              selectedPath={targetDir}
              onSelect={setTargetDir}
              expandedDirs={expandedDirs}
              onToggleDir={toggleDir}
            />
          </div>
          {(isUploading || error) && uploadItems.length > 0 && (
            <UploadProgress value={visibleProgress} items={uploadItems} />
          )}
          {error && (
            <p
              className="max-h-32 overflow-y-auto break-words rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFileInputChange}
          multiple
        />
        <input
          ref={folderInputRef}
          type="file"
          className="hidden"
          onChange={handleFileInputChange}
          {...{ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>}
          multiple
        />
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isUploading}>
            {t('cancel')}
          </Button>
          <Button variant="outline" onClick={handleSelectFolder} disabled={isUploading}>
            {isUploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FolderPlus className="mr-2 h-4 w-4" />}
            {t('uploadFolder')}
          </Button>
          <Button variant="secondary" onClick={handleSelectFiles} disabled={isUploading}>
            {isUploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
            {t('uploadFileAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
