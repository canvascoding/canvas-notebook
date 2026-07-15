'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useFileStore } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { createWorkspaceFileTransitionId } from '@/app/lib/files/open-transition';
import { notifyWorkspaceFileOpened } from '@/app/lib/files/workspace-file-events';
import { completeCreatedWorkspaceItem } from '@/app/lib/files/create-follow-up';
import type { CreateItemType } from './CreateItemDialog';

interface UseCreateItemDialogOptions {
  onBeforeOpen?: () => void;
  onFileOpened?: (path: string) => void;
}

export function useCreateItemDialog(options: UseCreateItemDialogOptions = {}) {
  const { onBeforeOpen, onFileOpened } = options;
  const t = useTranslations('notebook');
  const createPath = useFileStore((state) => state.createPath);
  const createdWorkspaceIdRef = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<CreateItemType>('file');

  const openCreateDialog = useCallback((nextType: CreateItemType) => {
    onBeforeOpen?.();
    setType(nextType);
    setOpen(true);
  }, [onBeforeOpen]);

  const handleCreate = useCallback(async (
    fullPath: string,
    itemType: 'file' | 'directory',
    options?: { template?: 'excalidraw' }
  ) => {
    createdWorkspaceIdRef.current = useWorkspaceStore.getState().activeWorkspaceId;
    try {
      await createPath(fullPath, itemType, options);
    } catch (error) {
      createdWorkspaceIdRef.current = null;
      throw error;
    }
  }, [createPath]);

  const handleCreated = useCallback((fullPath: string, itemType: 'file' | 'directory') => {
    const workspaceId = createdWorkspaceIdRef.current;
    createdWorkspaceIdRef.current = null;
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
        toast.error(error instanceof Error ? error.message : t('failedToLoadPreview'));
      });
  }, [onFileOpened, t]);

  return {
    openCreateDialog,
    createDialogProps: {
      open,
      onOpenChange: setOpen,
      type,
      onCreate: handleCreate,
      onCreated: handleCreated,
    },
  };
}
