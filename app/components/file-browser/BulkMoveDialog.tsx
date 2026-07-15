'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileWarning } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useFileStore } from '@/app/store/file-store';
import { compactWorkspaceSelection, getWorkspacePathName } from '@/app/lib/files/operation-flows';
import { DirectoryBrowser } from './DirectoryBrowser';
import { useShallow } from 'zustand/react/shallow';
import type { WorkspaceMoveController, WorkspaceMoveResolution } from './useWorkspaceMove';

interface BulkMoveDialogProps {
  controller: WorkspaceMoveController;
}

export function BulkMoveDialog({ controller }: BulkMoveDialogProps) {
  const t = useTranslations('notebook');
  const [moveTarget, setMoveTarget] = useState('.');
  const [moveExpandedDirs, setMoveExpandedDirs] = useState(new Set<string>());
  const {
    fileTree,
    multiSelectPaths,
    bulkMoveOpen,
    setBulkMoveOpen,
  } = useFileStore(useShallow((state) => ({
    fileTree: state.fileTree,
    multiSelectPaths: state.multiSelectPaths,
    bulkMoveOpen: state.bulkMoveOpen,
    setBulkMoveOpen: state.setBulkMoveOpen,
  })));
  const { conflict, isMoving, startMove, resolveConflict } = controller;

  const resetDialogState = () => {
    setMoveTarget('.');
    setMoveExpandedDirs(new Set());
  };

  const selectedMovePaths = useMemo(
    () => compactWorkspaceSelection(multiSelectPaths),
    [multiSelectPaths],
  );

  const closeDialog = () => {
    resetDialogState();
    setBulkMoveOpen(false);
  };

  const toggleMoveDir = (path: string) => {
    setMoveExpandedDirs(prev => {
      const newSet = new Set(prev);
      if (newSet.has(path)) {
        newSet.delete(path);
      } else {
        newSet.add(path);
      }
      return newSet;
    });
  };

  const handleConfirmMove = async () => {
    const result = await startMove(selectedMovePaths, moveTarget);
    if (result === 'completed') closeDialog();
  };

  const handleConflictResolution = async (action: WorkspaceMoveResolution) => {
    const result = await resolveConflict(action);
    if (result === 'completed') closeDialog();
  };

  const handleCancel = () => {
    if (isMoving) return; // Prevent closing while moving
    closeDialog();
  };

  return (
    <>
      {/* Main Move Dialog */}
      <Dialog
        open={bulkMoveOpen && !conflict}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            handleCancel();
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('moveMultiple', { count: selectedMovePaths.length })}</DialogTitle>
            <DialogDescription>
              {t('moveDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-xs text-muted-foreground">{t('destinationFolder')}</label>
              <DirectoryBrowser
                tree={fileTree}
                selectedPath={moveTarget}
                onSelect={setMoveTarget}
                expandedDirs={moveExpandedDirs}
                onToggleDir={toggleMoveDir}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={handleCancel} disabled={isMoving}>
              {t('cancel')}
            </Button>
            <Button
              variant="secondary"
              onClick={handleConfirmMove}
              disabled={isMoving || selectedMovePaths.length === 0}
            >
              {isMoving ? t('moving') : t('move')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* File Conflict Dialog */}
      <Dialog open={conflict !== null} onOpenChange={() => {}}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileWarning className="h-5 w-5 text-yellow-500" />
              {t('fileConflictTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('fileConflictDescription', { 
                source: conflict?.sourcePath ? getWorkspacePathName(conflict.sourcePath) : '',
                destination: conflict?.destPath || '' 
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <p className="text-sm text-muted-foreground">
              {t('fileConflictExplanation')}
            </p>
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button 
              variant="ghost" 
              onClick={() => handleConflictResolution('skip')}
              className="w-full sm:w-auto"
            >
              {t('skipFile')}
            </Button>
            <Button 
              variant="outline" 
              onClick={() => handleConflictResolution('overwrite-existing')}
              className="w-full sm:w-auto"
            >
              {t('keepExisting')}
            </Button>
            <Button 
              variant="secondary" 
              onClick={() => handleConflictResolution('overwrite-selection')}
              className="w-full sm:w-auto"
            >
              {t('overwriteSelection')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
