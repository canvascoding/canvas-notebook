'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useFileStore } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { createWorkspaceFileTransitionId } from '@/app/lib/files/open-transition';
import { notifyWorkspaceFileOpened } from '@/app/lib/files/workspace-file-events';
import { completeCreatedWorkspaceItem } from '@/app/lib/files/create-follow-up';
import { openedDocumentAuthScope, subscribeOpenedDocumentAuthInvalidation, type OpenedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';
import type { CreateItemType } from './CreateItemDialog';

interface UseCreateItemDialogOptions {
  onBeforeOpen?: () => void;
  onFileOpened?: (path: string) => void;
}

export function useCreateItemDialog(options: UseCreateItemDialogOptions = {}) {
  const { onBeforeOpen, onFileOpened } = options;
  const t = useTranslations('notebook');
  const createPath = useFileStore((state) => state.createPath);
  const createdRef = useRef<{ workspaceId: string | null; scope: OpenedDocumentAuthScope | null; path: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<CreateItemType>('file');
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  useEffect(() => subscribeOpenedDocumentAuthInvalidation(() => { createdRef.current = null; setOpen(false); }), []);
  useEffect(() => useWorkspaceStore.subscribe((next, previous) => {
    if (next.activeWorkspaceId !== previous.activeWorkspaceId) { createdRef.current = null; setOpen(false); }
  }), []);

  const openCreateDialog = useCallback((nextType: CreateItemType) => {
    onBeforeOpen?.();
    setWorkspaceId(useWorkspaceStore.getState().activeWorkspaceId);
    setType(nextType);
    setOpen(true);
  }, [onBeforeOpen]);

  const handleCreate = useCallback(async (
    fullPath: string,
    itemType: 'file' | 'directory',
    options?: { template?: 'excalidraw'; workspaceId?: string | null; requestId?: string }
  ) => {
    const targetWorkspaceId = options?.workspaceId ?? workspaceId;
    if (targetWorkspaceId !== useWorkspaceStore.getState().activeWorkspaceId) throw new Error(t('markdownCreateScopeChanged'));
    const created = { workspaceId: targetWorkspaceId, scope: openedDocumentAuthScope(), path: fullPath };
    createdRef.current = created;
    try {
      await createPath(fullPath, itemType, { ...options, workspaceId: targetWorkspaceId });
      if (createdRef.current !== created || openedDocumentAuthScope() !== created.scope
        || useWorkspaceStore.getState().activeWorkspaceId !== targetWorkspaceId) {
        if (createdRef.current === created) createdRef.current = null;
        throw new Error(t('markdownCreateScopeChanged'));
      }
    } catch (error) {
      if (createdRef.current === created) createdRef.current = null;
      throw error;
    }
  }, [createPath, workspaceId, t]);

  const handleCreated = useCallback((fullPath: string, itemType: 'file' | 'directory') => {
    const created = createdRef.current;
    createdRef.current = null;
    if (!created || created.path !== fullPath || openedDocumentAuthScope() !== created.scope
      || useWorkspaceStore.getState().activeWorkspaceId !== created.workspaceId) return;
    const workspaceId = created.workspaceId;
    const transitionId = createWorkspaceFileTransitionId();
    void completeCreatedWorkspaceItem({
      path: fullPath,
      itemType,
      workspaceId,
      transitionId,
      getActiveWorkspaceId: () => useWorkspaceStore.getState().activeWorkspaceId,
      openFile: (path, openOptions) => (
        useFileStore.getState().revealAndLoadFile(path, openOptions)
      ),
      openDirectory: async (path, targetWorkspaceId) => {
        const store = useFileStore.getState();
        store.clearMultiSelect();
        store.selectNode({
          path,
          type: 'directory',
          name: path.split('/').pop() || path,
        });
        await store.loadSubdirectory(path, true, true, targetWorkspaceId);
      },
    })
      .then((result) => {
        if (openedDocumentAuthScope() !== created.scope || useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;
        if (result.status === 'opened') {
          notifyWorkspaceFileOpened(fullPath, 'file-browser');
          onFileOpened?.(fullPath);
          return;
        }
        if (result.status !== 'superseded' && result.status !== 'directory-opened') {
          toast.error(result.error || t('failedToLoadPreview'));
        }
      })
      .catch((error) => {
        if (openedDocumentAuthScope() !== created.scope || useWorkspaceStore.getState().activeWorkspaceId !== workspaceId) return;
        toast.error(error instanceof Error ? error.message : t('failedToLoadPreview'));
      });
  }, [onFileOpened, t]);

  return {
    openCreateDialog,
    createDialogProps: {
      open,
      onOpenChange: setOpen,
      type,
      workspaceId,
      onCreate: handleCreate,
      onCreated: handleCreated,
    },
  };
}
