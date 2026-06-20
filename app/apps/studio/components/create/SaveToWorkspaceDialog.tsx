'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
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
import { WorkspaceDestinationPicker } from '@/app/components/workspaces/WorkspaceDestinationPicker';
import { selectActiveWorkspace, useWorkspaceStore } from '@/app/store/workspace-store';
import { toast } from 'sonner';

interface SaveToWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  outputIds: string[];
  onImported?: () => void;
}

export function SaveToWorkspaceDialog({ open, onOpenChange, outputIds, onImported }: SaveToWorkspaceDialogProps) {
  const t = useTranslations('studio.saveToWorkspace');
  const { refreshDirectory } = useFileStore();
  const activeWorkspace = useWorkspaceStore(selectActiveWorkspace);
  const [selectedDir, setSelectedDir] = useState('.');
  const [targetWorkspaceId, setTargetWorkspaceId] = useState<string | null>(activeWorkspace?.id ?? null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedDir('.');
      setTargetWorkspaceId(activeWorkspace?.id ?? null);
    }
  }, [activeWorkspace?.id, open]);

  const handleSave = async () => {
    if (outputIds.length === 0 || !targetWorkspaceId) return;
    setIsSaving(true);
    try {
      const res = await fetch('/api/studio/outputs/save-to-workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputIds, targetPath: selectedDir, targetWorkspaceId }),
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || t('failed'));
      }

      const savedCount = typeof data.savedCount === 'number' ? data.savedCount : outputIds.length;
      if (targetWorkspaceId === activeWorkspace?.id) {
        await refreshDirectory(selectedDir, true);
      }
      toast.success(t('success', { count: savedCount }));
      onImported?.();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('failed'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('description', { count: outputIds.length })}
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 py-4">
          <WorkspaceDestinationPicker
            selectedWorkspaceId={targetWorkspaceId}
            selectedDir={selectedDir}
            onWorkspaceChange={setTargetWorkspaceId}
            onDirChange={setSelectedDir}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('cancel')}</Button>
          <Button onClick={handleSave} disabled={isSaving || outputIds.length === 0 || !targetWorkspaceId}>
            {isSaving ? t('saving') : t('submit', { count: outputIds.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
