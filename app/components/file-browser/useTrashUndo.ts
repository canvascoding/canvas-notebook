'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

import { getParentDirectory } from '@/app/lib/files/path-utils';
import {
  restoreWorkspaceTrashEntry,
  type DeleteWorkspacePathsResult,
} from '@/app/lib/files/client';
import { useFileStore } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';

export function useTrashUndo() {
  const t = useTranslations('notebook');
  const { deletePath, refreshDirectory } = useFileStore(useShallow((state) => ({
    deletePath: state.deletePath,
    refreshDirectory: state.refreshDirectory,
  })));
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);

  return useCallback(async (paths: string | string[]): Promise<DeleteWorkspacePathsResult> => {
    const workspaceId = activeWorkspaceId;
    const result = await deletePath(paths);
    const trashEntries = result.trashEntries ?? [];
    if (trashEntries.length === 0) return result;

    let isRestoring = false;
    toast.success(t('movedToTrash', { count: trashEntries.length }), {
      duration: 8000,
      action: {
        label: t('undo'),
        onClick: () => {
          if (isRestoring) return;
          isRestoring = true;
          void (async () => {
            const restoredPaths: string[] = [];
            try {
              for (const entry of trashEntries) {
                const restored = await restoreWorkspaceTrashEntry(entry.id, workspaceId);
                restoredPaths.push(restored.originalPath);
              }
              toast.success(t('restoredFromTrash', { count: restoredPaths.length }));
            } catch (error) {
              toast.error(error instanceof Error ? error.message : t('restoreFromTrashFailed'));
            } finally {
              if (
                restoredPaths.length > 0
                && useWorkspaceStore.getState().activeWorkspaceId === workspaceId
              ) {
                const parentDirectories = Array.from(new Set(
                  restoredPaths.map(getParentDirectory),
                ));
                for (const parentDirectory of parentDirectories) {
                  await refreshDirectory(parentDirectory, true, workspaceId);
                }
              }
            }
          })();
        },
      },
    });
    return result;
  }, [activeWorkspaceId, deletePath, refreshDirectory, t]);
}
