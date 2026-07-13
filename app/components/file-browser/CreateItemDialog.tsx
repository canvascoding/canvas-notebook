'use client';

import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
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

export type CreateItemType = 'file' | 'directory' | 'excalidraw';

interface CreateItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: CreateItemType;
  defaultPath: string;
  onCreate: (fullPath: string, type: 'file' | 'directory', options?: { template?: 'excalidraw' }) => Promise<void>;
}

function hasExtension(name: string): boolean {
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) return false;
  return lastDot < name.length - 1;
}

function hasExcalidrawExtension(name: string): boolean {
  return name.toLowerCase().endsWith('.excalidraw');
}

export function CreateItemDialog({ open, onOpenChange, type, defaultPath, onCreate }: CreateItemDialogProps) {
  const t = useTranslations('notebook');
  const fileTree = useFileStore((state) => state.fileTree);
  const [name, setName] = useState('');
  const [targetDir, setTargetDir] = useState(defaultPath);
  const [expandedDirs, setExpandedDirs] = useState(new Set<string>());
  const [error, setError] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    if (open) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setName('');
      setTargetDir(defaultPath);
      setExpandedDirs(new Set());
      setError('');
      setIsCreating(false);
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [open, defaultPath]);

  const validate = (): string | null => {
    const trimmed = name.trim();
    if (!trimmed) {
      return t('nameRequired');
    }
    return null;
  };

  const getResolvedName = (): string => {
    const trimmed = name.trim();
    if (type === 'excalidraw' && !hasExcalidrawExtension(trimmed)) {
      return `${trimmed}.excalidraw`;
    }
    if (type === 'file' && !hasExtension(trimmed)) {
      return `${trimmed}.md`;
    }
    return trimmed;
  };

  const handleCreate = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    const resolvedName = getResolvedName();
    const fullPath = targetDir === '.' ? resolvedName : `${targetDir}/${resolvedName}`;
    setIsCreating(true);
    try {
      await onCreate(
        fullPath,
        type === 'directory' ? 'directory' : 'file',
        type === 'excalidraw' ? { template: 'excalidraw' } : undefined
      );
      onOpenChange(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t('createFailed'));
    } finally {
      setIsCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isCreating) {
      e.preventDefault();
      void handleCreate();
    }
  };

  const handleChange = (value: string) => {
    setName(value);
    if (error) setError('');
  };

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

  const resolvedPreview = (type === 'file' || type === 'excalidraw') && name.trim()
    ? getResolvedName() === name.trim() ? null : getResolvedName()
    : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isCreating || nextOpen) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {type === 'excalidraw'
              ? t('createExcalidrawTitle')
              : type === 'file'
                ? t('createFileTitle')
                : t('createFolderTitle')}
          </DialogTitle>
          <DialogDescription>
            {type === 'excalidraw'
              ? t('createExcalidrawDescription')
              : type === 'file'
                ? t('createFileDescription')
                : t('createFolderDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label htmlFor="createItemName" className="text-xs text-muted-foreground">
              {type === 'directory' ? t('folderNameLabel') : t('fileNameLabel')}
            </label>
            <Input
              id="createItemName"
              value={name}
              onChange={(e) => handleChange(e.target.value)}
              className="mt-1"
              onKeyDown={handleKeyDown}
              placeholder={
                type === 'excalidraw'
                  ? t('excalidrawNamePlaceholder')
                  : type === 'file'
                    ? t('fileNamePlaceholder')
                    : t('folderNamePlaceholder')
              }
              autoFocus
              disabled={isCreating}
            />
            {error && (
              <p className="mt-1.5 text-xs text-destructive" role="alert">{error}</p>
            )}
            {resolvedPreview && !error && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t('extensionAdded', { name: resolvedPreview })}
              </p>
            )}
          </div>
          <div>
            <label htmlFor="createItemTargetDir" className="text-xs text-muted-foreground">{t('saveIn')}</label>
            <Input
              id="createItemTargetDir"
              value={targetDir}
              onChange={(e) => setTargetDir(e.target.value)}
              className="mt-1"
              disabled={isCreating}
            />
          </div>
          <div className={isCreating ? 'pointer-events-none opacity-60' : undefined}>
            <DirectoryBrowser
              tree={fileTree}
              selectedPath={targetDir}
              onSelect={setTargetDir}
              expandedDirs={expandedDirs}
              onToggleDir={toggleDir}
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isCreating}>
            {t('cancel')}
          </Button>
          <Button variant="secondary" onClick={() => void handleCreate()} disabled={isCreating}>
            {isCreating && <Loader2 className="h-4 w-4 animate-spin" />}
            {type === 'excalidraw'
              ? t('createExcalidraw')
              : type === 'file'
                ? t('createFile')
                : t('createFolder')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
