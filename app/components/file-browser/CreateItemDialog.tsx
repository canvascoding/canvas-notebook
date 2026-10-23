'use client';

import { useState, useEffect, useRef } from 'react';
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
import { DirectoryDestinationPicker } from './DirectoryDestinationPicker';
import { MarkdownCreatePendingAttempts } from './MarkdownCreatePendingAttempts';
import { WorkspaceMarkdownCreatePendingError } from '@/app/lib/files/client';
import { MarkdownCreateAttemptError } from '@/app/store/markdown-create-store';
import { normalizeWorkspacePathParam } from '@/app/lib/files/path-utils';
import { isManualMarkdownCreatePath, type ManualMarkdownCreateAttempt } from '@/app/lib/files/markdown-create-result';

export type CreateItemType = 'file' | 'directory' | 'excalidraw';

interface CreateItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: CreateItemType;
  defaultPath: string;
  workspaceId: string | null;
  onCreate: (fullPath: string, type: 'file' | 'directory', options?: { template?: 'excalidraw'; workspaceId?: string | null; requestId?: string }) => Promise<void>;
  onCreated?: (fullPath: string, type: 'file' | 'directory') => void;
}

function hasExtension(name: string): boolean {
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) return false;
  return lastDot < name.length - 1;
}

function hasExcalidrawExtension(name: string): boolean {
  return name.toLowerCase().endsWith('.excalidraw');
}

export function CreateItemDialog({ open, onOpenChange, type, defaultPath, workspaceId, onCreate, onCreated }: CreateItemDialogProps) {
  const t = useTranslations('notebook');
  const fileTree = useFileStore((state) => state.fileTree);
  const [name, setName] = useState('');
  const [targetDir, setTargetDir] = useState(defaultPath);
  const [expandedDirs, setExpandedDirs] = useState(new Set<string>());
  const [error, setError] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [creatingDirectory, setCreatingDirectory] = useState(false);
  const wasOpen = useRef(false);
  const generationRef = useRef(0);
  const pendingRef = useRef<object | null>(null);
  const activeRef = useRef(true);
  useEffect(() => { activeRef.current = true; return () => { activeRef.current = false; }; }, []);

  useEffect(() => {
    if (open !== wasOpen.current) {
      generationRef.current++;
      pendingRef.current = null;
    }
    if (open && !wasOpen.current) {
      setName('');
      setTargetDir(defaultPath);
      setExpandedDirs(new Set());
      setError('');
      setIsCreating(false);
    }
    wasOpen.current = open;
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
    if (pendingRef.current || isCreating || creatingDirectory) return;
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    const resolvedName = getResolvedName();
    const rawPath = targetDir === '.' ? resolvedName : `${targetDir}/${resolvedName}`;
    const fullPath = type === 'file' && isManualMarkdownCreatePath(rawPath) ? normalizeWorkspacePathParam(rawPath) : rawPath;
    if (!fullPath) { setError(t('nameRequired')); return; }
    await submitCreation(fullPath, type === 'directory' ? 'directory' : 'file');
  };

  const submitCreation = async (fullPath: string, itemType: 'file' | 'directory', requestId?: string) => {
    if (pendingRef.current) return;
    const request = {};
    const generation = generationRef.current;
    pendingRef.current = request;
    const current = () => activeRef.current && wasOpen.current && generationRef.current === generation
      && pendingRef.current === request;
    setIsCreating(true);
    setError('');
    try {
      await onCreate(
        fullPath,
        itemType,
        { ...(type === 'excalidraw' && !requestId ? { template: 'excalidraw' as const } : {}), workspaceId, requestId }
      );
      if (!current()) return;
      onOpenChange(false);
      onCreated?.(fullPath, itemType);
    } catch (createError) {
      if (!current()) return;
      setError(createError instanceof WorkspaceMarkdownCreatePendingError ? t('markdownCreateUnconfirmed')
        : createError instanceof MarkdownCreateAttemptError ? t(createError.code === 'MARKDOWN_CREATE_LIMIT' ? 'markdownCreateLimit' : 'markdownCreateScopeChanged')
          : createError instanceof Error ? createError.message : t('createFailed'));
    } finally {
      if (pendingRef.current === request) {
        if (current()) setIsCreating(false);
        pendingRef.current = null;
      }
    }
  };

  const resumeCreation = async (attempt: ManualMarkdownCreateAttempt) => {
    if (attempt.workspaceId !== workspaceId || creatingDirectory) return;
    await submitCreation(attempt.targetPath, 'file', attempt.requestId);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isCreating && !creatingDirectory) {
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
        if ((!isCreating && !creatingDirectory) || nextOpen) onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-w-xl max-h-[calc(100dvh-3rem)] overflow-y-auto">
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
              disabled={isCreating || creatingDirectory}
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
              disabled={isCreating || creatingDirectory}
            />
          </div>
          <div>
            {open && <DirectoryDestinationPicker
              tree={fileTree}
              selectedPath={targetDir}
              onSelect={setTargetDir}
              expandedDirs={expandedDirs}
              onToggleDir={toggleDir}
              disabled={isCreating}
              workspaceId={workspaceId}
              onCreatingDirectoryChange={setCreatingDirectory}
            />}
          </div>
          {open ? <MarkdownCreatePendingAttempts workspaceId={workspaceId} disabled={isCreating || creatingDirectory} onResume={resumeCreation} /> : null}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isCreating || creatingDirectory}>
            {t('cancel')}
          </Button>
          <Button variant="secondary" onClick={() => void handleCreate()} disabled={isCreating || creatingDirectory}>
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
