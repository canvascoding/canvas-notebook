'use client';

import { useState } from 'react';
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
import { getWorkspacePathName, isMoveIntoSelf, resolveMoveDestination } from '@/app/lib/files/operation-flows';
import { toast } from 'sonner';
import { DirectoryBrowser } from './DirectoryBrowser';

interface ConflictState {
  type: 'file' | 'directory';
  sourcePath: string;
  destPath: string;
  remainingPaths: string[];
  successCount: number;
}

export function BulkMoveDialog() {
  const t = useTranslations('notebook');
  const [moveTarget, setMoveTarget] = useState('.');
  const [moveExpandedDirs, setMoveExpandedDirs] = useState(new Set<string>());
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const {
    fileTree,
    multiSelectPaths,
    clearMultiSelect,
    renamePath,
    loadFileTree,
    bulkMoveOpen,
    setBulkMoveOpen,
  } = useFileStore();

  const resetDialogState = () => {
    setMoveTarget('.');
    setMoveExpandedDirs(new Set());
    setConflict(null);
    setIsMoving(false);
  };

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

  const completeMove = async (successCount: number) => {
    clearMultiSelect();
    await loadFileTree('.', undefined, true);
    closeDialog();
    toast.success(t('moveMultipleSuccess', { count: successCount }));
  };

  const processMoveQueue = async (pathsToMove: string[], initialSuccessCount = 0) => {
    let successCount = initialSuccessCount;

    for (let index = 0; index < pathsToMove.length; index++) {
      const path = pathsToMove[index];
      const destination = resolveMoveDestination(moveTarget, getWorkspacePathName(path));

      if (path === destination) {
        successCount++;
        continue;
      }

      if (isMoveIntoSelf(path, destination)) {
        toast.error(t('moveIntoSelf'));
        setIsMoving(false);
        return;
      }

      try {
        await renamePath(path, destination);
        successCount++;
      } catch (error) {
        const err = error as Error & { code?: string; type?: string; sourcePath?: string; destPath?: string };

        if (err.code === 'FILE_EXISTS') {
          setConflict({
            type: (err.type === 'directory' ? 'directory' : 'file'),
            sourcePath: err.sourcePath || path,
            destPath: err.destPath || destination,
            remainingPaths: pathsToMove.slice(index + 1),
            successCount,
          });
          return;
        }

        if (err.code === 'DIRECTORY_EXISTS') {
          toast.error(t('directoryConflictError', {
            source: path || '',
            destination,
          }));
          setIsMoving(false);
          return;
        }

        if (err.code === 'SOURCE_NOT_FOUND') {
          toast.error(t('sourceNotFoundError', { path: path || '' }));
          setIsMoving(false);
          return;
        }

        console.error(`Failed to move ${path}:`, error);
        toast.error(t('moveError', { path, error: err.message }));
        setIsMoving(false);
        return;
      }
    }

    await completeMove(successCount);
  };

  const handleConflictResolution = async (action: 'overwrite-selection' | 'overwrite-existing' | 'skip') => {
    if (!conflict) return;

    const activeConflict = conflict;
    setConflict(null);

    if (action === 'skip') {
      await processMoveQueue(activeConflict.remainingPaths, activeConflict.successCount);
    } else if (action === 'overwrite-selection') {
      try {
        await renamePath(activeConflict.sourcePath, activeConflict.destPath, true);
        await processMoveQueue(activeConflict.remainingPaths, activeConflict.successCount + 1);
      } catch (error) {
        handleMoveError(error);
      }
    } else if (action === 'overwrite-existing') {
      await processMoveQueue(activeConflict.remainingPaths, activeConflict.successCount);
    }
  };

  const handleMoveError = (error: unknown) => {
    const err = error as Error & { code?: string; type?: string; sourcePath?: string; destPath?: string };
    
    if (err.code === 'DIRECTORY_EXISTS') {
      toast.error(t('directoryConflictError', { destination: err.destPath || '' }));
      setIsMoving(false);
      return;
    }
    
    if (err.code === 'SOURCE_NOT_FOUND') {
      toast.error(t('sourceNotFoundError', { path: err.sourcePath || '' }));
      setIsMoving(false);
      return;
    }
    
    // For other errors, show generic error
    toast.error(t('moveError', { error: err.message }));
    setIsMoving(false);
  };

  const handleConfirmMove = async () => {
    setIsMoving(true);
    await processMoveQueue(Array.from(multiSelectPaths));
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
            <DialogTitle>{t('moveMultiple', { count: multiSelectPaths.size })}</DialogTitle>
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
            <Button variant="secondary" onClick={handleConfirmMove} disabled={isMoving}>
              {isMoving ? t('moving') : t('move')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* File Conflict Dialog */}
      <Dialog open={bulkMoveOpen && conflict !== null} onOpenChange={() => {}}>
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
