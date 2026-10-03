'use client';

import { useCallback, useLayoutEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

import { getParentDirectory } from '@/app/lib/files/path-utils';
import {
  restoreWorkspaceTrashEntry,
  WorkspaceDeletePartialError,
  type DeleteWorkspacePathsResult,
} from '@/app/lib/files/client';
import { useFileStore } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { openWorkspaceOperationReview } from '@/app/store/workspace-operation-review-store';
import { openWorkspacePathOperationStatus } from '@/app/store/workspace-path-operation-store';
import { useDocumentReviewAvailability } from '@/app/components/file-version-center/DocumentReviewAvailabilityProvider';
import { undoWorkspacePathOperation } from '@/app/lib/files/workspace-path-operation-client';
import { useFileActionToastTarget } from './FileActionToastScope';
import { openedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';

export function useTrashUndo(options: { toasterId?: string } = {}) {
  const t = useTranslations('notebook');
  const reviewAvailability = useDocumentReviewAvailability();
  const reviewCenterEnabled = reviewAvailability.ready && reviewAvailability.documentReviewEnabled;
  const reviewCenterEnabledRef = useRef(reviewCenterEnabled);
  useLayoutEffect(() => { reviewCenterEnabledRef.current = reviewCenterEnabled; }, [reviewCenterEnabled]);
  const toastTarget = useFileActionToastTarget(options.toasterId);
  const { deletePath, refreshDirectory } = useFileStore(useShallow((state) => ({
    deletePath: state.deletePath,
    refreshDirectory: state.refreshDirectory,
  })));
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);

  return useCallback(async (paths: string | string[]): Promise<DeleteWorkspacePathsResult> => {
    const workspaceId = activeWorkspaceId;
    const authScope = openedDocumentAuthScope();
    let partialError: WorkspaceDeletePartialError | null = null;
    const result = await deletePath(paths, workspaceId).catch((error) => {
      if (!(error instanceof WorkspaceDeletePartialError)) throw error;
      partialError = error;
      return error.result;
    });
    if (result.reviewRequired) {
      if (result.reviewRequired.workspaceId === workspaceId
        && useWorkspaceStore.getState().activeWorkspaceId === workspaceId
        && openedDocumentAuthScope() === authScope) {
        if (reviewCenterEnabledRef.current) openWorkspaceOperationReview(result.reviewRequired.reviewId, workspaceId);
        else void openWorkspacePathOperationStatus({ reviewId: result.reviewRequired.reviewId, workspaceId });
        window.dispatchEvent(new CustomEvent('notification_summary_updated'));
      }
      return result;
    }
    const trashEntries = result.trashEntries ?? [];
    if (trashEntries.length === 0) {
      if (partialError) throw partialError;
      return result;
    }

    let isRestoring = false;
    toast.success(t('movedToTrash', { count: trashEntries.length }), {
      ...toastTarget(),
      duration: 8000,
      action: {
        label: t('undo'),
        onClick: () => {
          if (isRestoring) return;
          isRestoring = true;
          void (async () => {
            const restoredPaths: string[] = [];
            try {
              if (result.operation) {
                await undoWorkspacePathOperation(result.operation);
                restoredPaths.push(...trashEntries.map((entry) => entry.originalPath));
              } else for (const entry of trashEntries) {
                const restored = await restoreWorkspaceTrashEntry(entry.id, workspaceId);
                restoredPaths.push(restored.originalPath);
              }
              toast.success(t('restoredFromTrash', { count: restoredPaths.length }), toastTarget());
            } catch (error) {
              toast.error(error instanceof Error ? error.message : t('restoreFromTrashFailed'), toastTarget());
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
    if (partialError) throw partialError;
    return result;
  }, [activeWorkspaceId, deletePath, refreshDirectory, t, toastTarget]);
}
