'use client';

import { useState, useEffect } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { getWorkspacePathName } from '@/app/lib/files/operation-flows';
import { previewWorkspaceDelete, type WorkspaceFileOperationDryRun } from '@/app/lib/files/client';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { openedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';

interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paths: string[];
  skippedCount: number;
  onConfirm: (planId?: string) => Promise<void>;
}

export function DeleteConfirmDialog({ open, onOpenChange, paths, skippedCount, onConfirm }: DeleteConfirmDialogProps) {
  const t = useTranslations('notebook');
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<WorkspaceFileOperationDryRun | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const workspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  const pathsKey = JSON.stringify(paths);

  useEffect(() => {
    if (!open) return;
    let current = true;
    const authScope = openedDocumentAuthScope();
    /* eslint-disable react-hooks/set-state-in-effect */
    setPreview(null);
    setIsPreviewing(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    void previewWorkspaceDelete(JSON.parse(pathsKey) as string[], workspaceId).then(value => {
      if (current && openedDocumentAuthScope() === authScope
        && useWorkspaceStore.getState().activeWorkspaceId === workspaceId) setPreview(value);
    }).catch(failure => {
      if (current && openedDocumentAuthScope() === authScope) setError(failure instanceof Error ? failure.message : 'Could not preview deletion.');
    }).finally(() => { if (current) setIsPreviewing(false); });
    return () => { current = false; };
  }, [open, workspaceId, pathsKey]);

  useEffect(() => {
    if (open) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setIsDeleting(false);
      setError('');
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [open]);

  const handleConfirm = async () => {
    if (!preview || isPreviewing || preview.plan.readiness === 'blocked') return;
    setIsDeleting(true);
    setError('');
    try {
      await onConfirm(preview.plan.planId);
      onOpenChange(false);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t('deleteFailed'));
    } finally {
      setIsDeleting(false);
    }
  };

  const isMultiple = paths.length > 1;

  const title = isMultiple
    ? t('deleteMultipleTitle', { count: paths.length })
    : t('deleteSingleTitle', { name: paths[0] ? getWorkspacePathName(paths[0]) : '' });

  let description = isMultiple
    ? t('deleteMultipleDescription', { count: paths.length })
    : t('deleteSingleConfirm', { name: paths[0] ? getWorkspacePathName(paths[0]) : '' });

  if (skippedCount > 0) {
    description += ' ' + t('deleteSkippedInfo', { count: skippedCount });
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isDeleting || nextOpen) onOpenChange(nextOpen);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Trash2 className="text-destructive" />
          </AlertDialogMedia>
          <AlertDialogTitle className="min-w-0 [overflow-wrap:anywhere]">{title}</AlertDialogTitle>
          <AlertDialogDescription className="min-w-0 [overflow-wrap:anywhere]">{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {isMultiple && paths.length <= 10 && (
          <div className="max-h-32 overflow-auto rounded border border-border bg-muted/40 p-2">
            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {paths.map((p) => (
                <li key={p} className="truncate">{p}</li>
              ))}
            </ul>
          </div>
        )}
        {isPreviewing && <p className="text-sm" role="status"><Loader2 className="inline h-4 w-4 animate-spin" /> {t('fileOperationPreview')}</p>}
        {preview && <section className="max-h-48 space-y-2 overflow-auto rounded border p-2 text-sm" aria-live="polite">
          {preview.plan.kind === 'native-path-import-preparation' ? <>
            <p>{t('fileOperationImportSummary', { count: preview.plan.imports.length })}</p>
            {preview.plan.imports.map(item => <p key={item.path} className="break-all font-mono text-xs">{item.path}</p>)}
            <p>{t('fileOperationImportLinks', { count: preview.plan.physicalLinkChanges.length })}</p>
            <p className="text-muted-foreground">{t('fileOperationImportRevalidate')}</p>
          </> : <p>{t('fileOperationPreviewSummary', { paths: paths.length, links: preview.plan.linkEdits.length })}</p>}
          {preview.plan.readiness === 'blocked' && <p className="text-destructive">{t('fileOperationPreviewBlockedApply')}</p>}
        </section>}
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(event) => {
              event.preventDefault();
              void handleConfirm();
            }}
            disabled={isDeleting || isPreviewing || !preview || preview.plan.readiness === 'blocked'}
          >
            {isDeleting && <Loader2 className="h-4 w-4 animate-spin" />}
            {isDeleting ? t('deleting') : t('delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
