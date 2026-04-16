'use client';

import { useState, useEffect, type ReactNode } from 'react';
import { ChevronRight, Folder } from 'lucide-react';
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
import { useFileStore, type FileNode } from '@/app/store/file-store';

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

  const renderDirectories = (nodes: FileNode[], depth = 0): ReactNode[] => {
    return nodes.flatMap((entry) => {
      if (entry.type !== 'directory') return [];

      const isSelected = targetDir === entry.path;
      const isExpanded = expandedDirs.has(entry.path);

      const row = (
        <div key={entry.path} className="flex items-center" style={{ paddingLeft: `${depth * 12}px` }}>
          <button
            type="button"
            className="p-1 rounded hover:bg-accent/70"
            onClick={() => toggleDir(entry.path)}
          >
            <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
          </button>
          <button
            type="button"
            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${
              isSelected ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/70'
            }`}
            onClick={() => setTargetDir(entry.path)}
          >
            <Folder className="h-4 w-4 text-muted-foreground" />
            <span className="truncate">{entry.name}</span>
          </button>
        </div>
      );

      const children = isExpanded && entry.children ? renderDirectories(entry.children, depth + 1) : [];
      return [row, ...children];
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
          <div className="rounded border border-border bg-muted/40 p-2">
            <div className="mb-2 text-xs text-muted-foreground">{t('chooseDestination')}</div>
            <div className="max-h-56 overflow-auto">
              <button
                type="button"
                className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${
                  targetDir === '.'
                    ? 'bg-accent text-accent-foreground'
                    : 'text-foreground hover:bg-accent/70'
                }`}
                onClick={() => setTargetDir('.')}
              >
                <Folder className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{t('rootDirectory')}</span>
              </button>
              {renderDirectories(fileTree)}
            </div>
          </div>
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