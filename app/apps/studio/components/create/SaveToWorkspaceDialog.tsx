'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
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
}

export function SaveToWorkspaceDialog({ open, onOpenChange, outputIds }: SaveToWorkspaceDialogProps) {
  const { fileTree, refreshDirectory } = useFileStore();
  const [selectedDir, setSelectedDir] = useState('.');
  const [expandedDirs, setExpandedDirs] = useState(new Set<string>());
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (open) {
      void refreshDirectory('.');
    }
  }, [open, refreshDirectory]);

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
  };

  const handleSave = async () => {
    if (outputIds.length === 0) return;
    setIsSaving(true);
    try {
      const results: string[] = [];
      for (const outputId of outputIds) {
        const res = await fetch('/api/studio/outputs/save-to-workspace', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outputId, targetPath: selectedDir }),
        });
        const data = await res.json();
        if (!data.success) {
          throw new Error(data.error || `Failed to save ${outputId}`);
        }
        results.push(data.path);
      }
      toast.success(`${results.length} Element(e) im Workspace gespeichert`);
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Speichern fehlgeschlagen');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>In Workspace speichern</DialogTitle>
        </DialogHeader>
        <div className="py-4">
          <p className="text-sm text-muted-foreground mb-4">
            Wähle einen Zielordner im Workspace:
          </p>
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
            {isSaving ? 'Speichern...' : 'Speichern'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
