'use client';

import { useState, useEffect, useRef } from 'react';
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
import { studioApiFetch } from '../../utils/studio-api';

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
  const [creatingDirectory, setCreatingDirectory] = useState(false);
  const saveRequestId = useRef(0);
  const sourceContext = JSON.stringify([activeWorkspace?.id ?? null, outputIds]);

  useEffect(() => {
    saveRequestId.current += 1;
    // A newly opened dialog or source must not inherit an older request's busy state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsSaving(false);
    if (open) {
      setSelectedDir('.');
      setTargetWorkspaceId(activeWorkspace?.id ?? null);
    }
    return () => { saveRequestId.current += 1; };
  }, [activeWorkspace?.id, open, sourceContext]);

  const handleSave = async () => {
    if (isSaving || creatingDirectory) return;
    if (!open || outputIds.length === 0 || !targetWorkspaceId) return;
    const sourceWorkspaceId = activeWorkspace?.id ?? null;
    if (useWorkspaceStore.getState().activeWorkspaceId !== sourceWorkspaceId) return;
    const requestId = ++saveRequestId.current;
    const targetId = targetWorkspaceId;
    const targetDirectory = selectedDir;
    const sourceOutputIds = [...outputIds];
    const current = () => requestId === saveRequestId.current
      && useWorkspaceStore.getState().activeWorkspaceId === sourceWorkspaceId;
    setIsSaving(true);
    try {
      const res = await studioApiFetch('/api/studio/outputs/save-to-workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outputIds: sourceOutputIds, targetPath: targetDirectory, targetWorkspaceId: targetId }),
      }, sourceWorkspaceId);
      const data = await res.json();
      if (!current()) return;
      if (!data.success) {
        throw new Error(data.error || t('failed'));
      }

      const savedCount = typeof data.savedCount === 'number' ? data.savedCount : sourceOutputIds.length;
      if (targetId === sourceWorkspaceId) {
        await refreshDirectory(targetDirectory, true, targetId);
      }
      if (!current()) return;
      toast.success(t('success', { count: savedCount }));
      onImported?.();
      onOpenChange(false);
    } catch (error) {
      if (current()) toast.error(error instanceof Error ? error.message : t('failed'));
    } finally {
      if (current()) setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (nextOpen || (!isSaving && !creatingDirectory)) onOpenChange(nextOpen);
    }}>
      <DialogContent className="max-w-lg max-h-[calc(100dvh-3rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {t('description', { count: outputIds.length })}
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 py-4">
          <WorkspaceDestinationPicker
            key={sourceContext}
            selectedWorkspaceId={targetWorkspaceId}
            selectedDir={selectedDir}
            onWorkspaceChange={setTargetWorkspaceId}
            onDirChange={setSelectedDir}
            disabled={isSaving}
            onCreatingDirectoryChange={setCreatingDirectory}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving || creatingDirectory}>{t('cancel')}</Button>
          <Button onClick={handleSave} disabled={isSaving || creatingDirectory || outputIds.length === 0 || !targetWorkspaceId}>
            {isSaving ? t('saving') : t('submit', { count: outputIds.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
