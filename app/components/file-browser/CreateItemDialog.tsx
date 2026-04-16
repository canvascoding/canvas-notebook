'use client';

import { useState, useEffect } from 'react';
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

interface CreateItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: 'file' | 'directory';
  defaultPath: string;
  onCreate: (fullPath: string, type: 'file' | 'directory') => Promise<void>;
}

function hasExtension(name: string): boolean {
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) return false;
  return lastDot < name.length - 1;
}

export function CreateItemDialog({ open, onOpenChange, type, defaultPath, onCreate }: CreateItemDialogProps) {
  const t = useTranslations('notebook');
  const { fileTree } = useFileStore();
  const [name, setName] = useState('');
  const [targetDir, setTargetDir] = useState(defaultPath);
  const [expandedDirs, setExpandedDirs] = useState(new Set<string>());
  const [error, setError] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setTargetDir(defaultPath);
      setExpandedDirs(new Set());
      setError('');
      setIsCreating(false);
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
      await onCreate(fullPath, type);
      onOpenChange(false);
    } catch {
      setError(t('createFailed'));
    } finally {
      setIsCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
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

  const resolvedPreview = type === 'file' && name.trim() && !hasExtension(name.trim())
    ? `${name.trim()}.md`
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {type === 'file' ? t('createFileTitle') : t('createFolderTitle')}
          </DialogTitle>
          <DialogDescription>
            {type === 'file' ? t('createFileDescription') : t('createFolderDescription')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label htmlFor="createItemName" className="text-xs text-muted-foreground">
              {type === 'file' ? t('fileNameLabel') : t('folderNameLabel')}
            </label>
            <Input
              id="createItemName"
              value={name}
              onChange={(e) => handleChange(e.target.value)}
              className="mt-1"
              onKeyDown={handleKeyDown}
              placeholder={type === 'file' ? t('fileNamePlaceholder') : t('folderNamePlaceholder')}
              autoFocus
            />
            {error && (
              <p className="mt-1.5 text-xs text-destructive">{error}</p>
            )}
            {resolvedPreview && !error && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t('extensionAdded', { name: resolvedPreview })}
              </p>
            )}
          </div>
          <div>
            <label className="text-xs text-muted-foreground">{t('saveIn')}</label>
            <Input
              value={targetDir}
              onChange={(e) => setTargetDir(e.target.value)}
              className="mt-1"
            />
          </div>
          <DirectoryBrowser
            tree={fileTree}
            selectedPath={targetDir}
            onSelect={setTargetDir}
            expandedDirs={expandedDirs}
            onToggleDir={toggleDir}
          />
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isCreating}>
            {t('cancel')}
          </Button>
          <Button variant="secondary" onClick={() => void handleCreate()} disabled={isCreating}>
            {type === 'file' ? t('createFile') : t('createFolder')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}