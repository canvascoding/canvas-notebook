'use client';

import { useState, useEffect, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, Folder, FileWarning } from 'lucide-react';
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
import { toast } from 'sonner';

interface ConflictState {
  type: 'file' | 'directory';
  sourcePath: string;
  destPath: string;
}

export function BulkMoveDialog() {
  const t = useTranslations('notebook');
  const [open, setOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState('.');
  const [moveExpandedDirs, setMoveExpandedDirs] = useState(new Set<string>());
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const { fileTree, multiSelectPaths, clearMultiSelect, renamePath, loadFileTree } = useFileStore();

  useEffect(() => {
    const handleOpen = () => {
      setOpen(true);
      setMoveTarget('.');
      setMoveExpandedDirs(new Set());
      setConflict(null);
      setIsMoving(false);
    };

    window.addEventListener('notebook-bulk-move-open', handleOpen);
    return () => window.removeEventListener('notebook-bulk-move-open', handleOpen);
  }, []);

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

  const renderMoveDirectories = (nodes: typeof fileTree, depth = 0): ReactNode[] => {
    return nodes.flatMap((entry) => {
      if (entry.type !== 'directory') return [];
      
      const isSelected = moveTarget === entry.path;
      const isExpanded = moveExpandedDirs.has(entry.path);
      
      const row = (
        <div key={entry.path} className="flex items-center" style={{ paddingLeft: `${depth * 12}px` }}>
          <button
            type="button"
            className="p-1 rounded hover:bg-accent/70"
            onClick={() => toggleMoveDir(entry.path)}
          >
            <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
          </button>
          <button
            type="button"
            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${
              isSelected ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/70'
            }`}
            onClick={() => setMoveTarget(entry.path)}
          >
            <Folder className="h-4 w-4 text-muted-foreground" />
            <span className="truncate">{entry.name}</span>
          </button>
        </div>
      );
      
      const children = isExpanded && entry.children ? renderMoveDirectories(entry.children, depth + 1) : [];
      return [row, ...children];
    });
  };

  const handleConflictResolution = async (action: 'overwrite-selection' | 'overwrite-existing' | 'skip') => {
    if (!conflict) return;

    setConflict(null);

    if (action === 'skip') {
      // Skip this file and continue with the rest
      await processRemainingMoves();
    } else if (action === 'overwrite-selection') {
      // Overwrite the existing file with the selected one
      try {
        await renamePath(conflict.sourcePath, conflict.destPath, true);
        await processRemainingMoves();
      } catch (error) {
        handleMoveError(error);
      }
    } else if (action === 'overwrite-existing') {
      // Skip the move to keep the existing file
      await processRemainingMoves();
    }
  };

  const handleMoveError = (error: unknown) => {
    const err = error as Error & { code?: string; type?: string; sourcePath?: string; destPath?: string };
    
    if (err.code === 'DIRECTORY_EXISTS') {
      toast.error(t('directoryConflictError', { path: err.destPath || '' }));
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

  const processRemainingMoves = async () => {
    // This will be called after a conflict is resolved
    // We need to continue with the remaining items
    // Since we already processed some items, we'll start from the current state
    await loadFileTree('.', undefined, true);
    clearMultiSelect();
    setOpen(false);
    setIsMoving(false);
    toast.success(t('moveMultipleSuccess', { count: multiSelectPaths.size }));
  };

  const handleConfirmMove = async () => {
    setIsMoving(true);
    let successCount = 0;
    const movedPaths: string[] = [];
    
    for (const path of multiSelectPaths) {
      const name = path.split('/').pop() || path;
      const destination = moveTarget === '.' ? name : `${moveTarget}/${name}`;
      
      if (path === destination) {
        successCount++;
        movedPaths.push(path);
        continue;
      }
      
      try {
        await renamePath(path, destination);
        successCount++;
        movedPaths.push(path);
      } catch (error) {
        const err = error as Error & { code?: string; type?: string; sourcePath?: string; destPath?: string };
        
        // Handle file conflict - show dialog
        if (err.code === 'FILE_EXISTS') {
          setConflict({
            type: (err.type === 'directory' ? 'directory' : 'file'),
            sourcePath: err.sourcePath || path,
            destPath: err.destPath || destination,
          });
          return; // Stop processing - user needs to resolve conflict
        }
        
        // Handle directory conflict - show error and stop
        if (err.code === 'DIRECTORY_EXISTS') {
          toast.error(t('directoryConflictError', { 
            source: path || '', 
            destination: destination 
          }));
          setIsMoving(false);
          return;
        }
        
        // Handle source not found - show error and stop
        if (err.code === 'SOURCE_NOT_FOUND') {
          toast.error(t('sourceNotFoundError', { path: path || '' }));
          setIsMoving(false);
          return;
        }
        
        // For any other error, stop and report
        console.error(`Failed to move ${path}:`, error);
        toast.error(t('moveError', { path: path, error: err.message }));
        setIsMoving(false);
        return;
      }
    }
    
    clearMultiSelect();
    setOpen(false);
    setIsMoving(false);
    await loadFileTree('.', undefined, true);
    toast.success(t('moveMultipleSuccess', { count: successCount }));
  };

  const handleCancel = () => {
    if (isMoving) return; // Prevent closing while moving
    setOpen(false);
    setConflict(null);
  };

  return (
    <>
      {/* Main Move Dialog */}
      <Dialog open={open && !conflict} onOpenChange={setOpen}>
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
              <div className="mt-1 rounded border border-border bg-muted/40 p-2">
                <div className="mb-2 text-xs text-muted-foreground">{t('chooseDestination')}</div>
                <div className="max-h-56 overflow-auto">
                  <button
                    type="button"
                    className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${
                      moveTarget === '.'
                        ? 'bg-accent text-accent-foreground'
                        : 'text-foreground hover:bg-accent/70'
                    }`}
                    onClick={() => setMoveTarget('.')}
                  >
                    <Folder className="h-4 w-4 text-muted-foreground" />
                    <span className="truncate">{t('rootDirectory')}</span>
                  </button>
                  {renderMoveDirectories(fileTree)}
                </div>
              </div>
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
      <Dialog open={conflict !== null} onOpenChange={() => {}}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileWarning className="h-5 w-5 text-yellow-500" />
              {t('fileConflictTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('fileConflictDescription', { 
                source: conflict?.sourcePath?.split('/').pop() || '',
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
