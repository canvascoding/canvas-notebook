'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useFileStore } from '@/app/store/file-store';
import { DirectoryBrowser } from '@/app/components/file-browser/DirectoryBrowser';
import { toast } from 'sonner';

interface SaveToWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  outputIds: string[];
  onImported?: () => void;
}

export function SaveToWorkspaceDialog({ open, onOpenChange, outputIds, onImported }: SaveToWorkspaceDialogProps) {
  const { fileTree, loadFileTree, refreshDirectory } = useFileStore();
  const [selectedDir, setSelectedDir] = useState('.');
  const [expandedDirs, setExpandedDirs] = useState(new Set<string>());
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (open) {
      void loadFileTree('.', 6, true);
    }
  }, [loadFileTree, open]);

  const handleToggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });

    void refreshDirectory(dirPath, true);
  };

  const handleSave = async () => {
    if (outputIds.length === 0) return;
    setIsSaving(true);
    try {
      const res = await fetch('/api/studio/outputs/save-to-workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputIds, targetPath: selectedDir }),
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Import fehlgeschlagen');
      }

      const savedCount = typeof data.savedCount === 'number' ? data.savedCount : outputIds.length;
      await refreshDirectory(selectedDir, true);
      toast.success(`${savedCount} Datei${savedCount === 1 ? '' : 'en'} in den Workspace importiert`);
      onImported?.();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Import fehlgeschlagen');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>In Workspace importieren</DialogTitle>
          <DialogDescription>
            Kopiert {outputIds.length} ausgewählte Datei{outputIds.length === 1 ? '' : 'en'} aus Studio in einen Workspace-Ordner.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <div className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Zielordner</p>
            <p className="mt-1 truncate font-mono text-sm">{selectedDir === '.' ? 'Workspace root' : selectedDir}</p>
          </div>
          <DirectoryBrowser
            tree={fileTree}
            selectedPath={selectedDir}
            onSelect={setSelectedDir}
            expandedDirs={expandedDirs}
            onToggleDir={handleToggleDir}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Abbrechen</Button>
          <Button onClick={handleSave} disabled={isSaving || outputIds.length === 0}>
            {isSaving ? 'Importiere...' : `${outputIds.length} Datei${outputIds.length === 1 ? '' : 'en'} importieren`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
