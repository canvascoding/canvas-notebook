'use client';

import { useState, useEffect, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, Folder } from 'lucide-react';
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

export function BulkMoveDialog() {
  const t = useTranslations('notebook');
  const [open, setOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState('.');
  const [moveExpandedDirs, setMoveExpandedDirs] = useState(new Set<string>());
  const { fileTree, multiSelectPaths, clearMultiSelect, renamePath, loadFileTree } = useFileStore();

  useEffect(() => {
    const handleOpen = () => {
      setOpen(true);
      setMoveTarget('.');
      setMoveExpandedDirs(new Set());
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

  const handleConfirmMove = async () => {
    let successCount = 0;
    
    for (const path of multiSelectPaths) {
      const name = path.split('/').pop() || path;
      const destination = moveTarget === '.' ? name : `${moveTarget}/${name}`;
      
      if (path === destination) {
        successCount++;
        continue;
      }
      
      try {
        await renamePath(path, destination);
        successCount++;
      } catch (error) {
        console.error(`Failed to move ${path}:`, error);
      }
    }
    
    clearMultiSelect();
    setOpen(false);
    await loadFileTree('.', undefined, true);
    toast.success(t('moveMultipleSuccess', { count: successCount }));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('moveMultiple', { count: multiSelectPaths.length })}</DialogTitle>
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
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {t('cancel')}
          </Button>
          <Button variant="secondary" onClick={handleConfirmMove}>
            {t('move')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
