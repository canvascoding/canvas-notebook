'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { FolderPlus, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { WorkspaceFileApiError } from '@/app/lib/files/client';

interface FolderCreationControlProps {
  parentPath: string;
  disabled?: boolean;
  onCreateDirectory: (parentPath: string, name: string) => Promise<string | null>;
  onCreatingDirectoryChange?: (busy: boolean) => void;
}

export function FolderCreationControl({ parentPath, disabled = false, onCreateDirectory,
  onCreatingDirectoryChange }: FolderCreationControlProps) {
  const t = useTranslations('notebook');
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const controlRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(true);
  const pendingRef = useRef(false);
  const previousEditingRef = useRef(false);
  const busyCallbackRef = useRef(onCreatingDirectoryChange);

  useEffect(() => { busyCallbackRef.current = onCreatingDirectoryChange; }, [onCreatingDirectoryChange]);
  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      if (pendingRef.current) busyCallbackRef.current?.(false);
    };
  }, []);
  useEffect(() => {
    if (editing && !busy) inputRef.current?.focus();
    else if (!editing && previousEditingRef.current) buttonRef.current?.focus();
    previousEditingRef.current = editing;
  }, [busy, editing]);
  // Radix listens on document capture; intercept Escape one level earlier.
  useEffect(() => {
    if (!editing) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !(event.target instanceof Node) || !controlRef.current?.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!pendingRef.current) {
        setEditing(false);
        setName('');
        setError('');
      }
    };
    window.addEventListener('keydown', handleEscape, true);
    return () => window.removeEventListener('keydown', handleEscape, true);
  }, [editing]);

  const cancel = () => {
    if (pendingRef.current) return;
    setEditing(false);
    setName('');
    setError('');
  };
  const create = async () => {
    if (disabled || pendingRef.current) return;
    const trimmed = name.trim();
    if (!trimmed || trimmed === '.' || trimmed === '..' || /[/\\\0]/u.test(trimmed)) {
      setError(t('folderInvalidName'));
      inputRef.current?.focus();
      return;
    }
    pendingRef.current = true;
    setBusy(true);
    setError('');
    busyCallbackRef.current?.(true);
    try {
      const createdPath = await onCreateDirectory(parentPath, trimmed);
      if (!activeRef.current || !createdPath) return;
      setEditing(false);
      setName('');
    } catch (cause) {
      if (!activeRef.current) return;
      setError(cause instanceof WorkspaceFileApiError && cause.code === 'PATH_EXISTS'
        ? t('folderAlreadyExists')
        : cause instanceof WorkspaceFileApiError && cause.status === 403
          ? t('folderCreatePermissionDenied')
          : cause instanceof Error ? cause.message : t('folderCreateFailed'));
      inputRef.current?.focus();
    } finally {
      pendingRef.current = false;
      if (activeRef.current) {
        setBusy(false);
        busyCallbackRef.current?.(false);
      }
    }
  };

  return (
    <div ref={controlRef} className="mt-2 border-t border-border pt-2" aria-busy={busy}>
      <Button ref={buttonRef} type="button" variant="outline" size="sm" disabled={disabled || busy}
        onClick={() => { setEditing(true); setError(''); }} aria-expanded={editing}>
        <FolderPlus className="h-4 w-4" />{t('newDestinationFolder')}
      </Button>
      {editing ? (
        <div className="mt-2 space-y-2" onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.stopPropagation();
            if (event.target === inputRef.current) {
              event.preventDefault();
              void create();
            }
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }
        }}>
          <p className="break-all text-xs text-muted-foreground">{t('newDestinationFolderIn', { path: parentPath === '.' ? '/' : `/${parentPath}` })}</p>
          <label htmlFor={inputId} className="text-xs text-muted-foreground">{t('newDestinationFolderName')}</label>
          <Input ref={inputRef} id={inputId} value={name} disabled={disabled || busy}
            onChange={(event) => { setName(event.target.value); setError(''); }}
            aria-invalid={Boolean(error)} aria-describedby={error ? `${inputId}-error` : undefined}
            placeholder={t('folderNamePlaceholder')} />
          {error ? <p id={`${inputId}-error`} role="alert" className="text-xs text-destructive">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={disabled || busy} onClick={() => void create()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {busy ? t('creatingDestinationFolder') : t('createFolder')}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={cancel}>{t('cancel')}</Button>
          </div>
          {busy ? <p role="status" className="text-xs text-muted-foreground">{t('creatingDestinationFolder')}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
