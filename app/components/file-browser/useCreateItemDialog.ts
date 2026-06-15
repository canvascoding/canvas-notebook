'use client';

import { useCallback, useState } from 'react';
import { useFileStore } from '@/app/store/file-store';
import type { CreateItemType } from './CreateItemDialog';

export function useCreateItemDialog(onBeforeOpen?: () => void) {
  const createPath = useFileStore((state) => state.createPath);
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
    await createPath(fullPath, itemType, options);
  }, [createPath]);

  return {
    openCreateDialog,
    createDialogProps: {
      open,
      onOpenChange: setOpen,
      type,
      onCreate: handleCreate,
    },
  };
}
