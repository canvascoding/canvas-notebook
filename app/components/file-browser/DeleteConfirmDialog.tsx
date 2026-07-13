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

interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  paths: string[];
  skippedCount: number;
  onConfirm: () => Promise<void>;
}

export function DeleteConfirmDialog({ open, onOpenChange, paths, skippedCount, onConfirm }: DeleteConfirmDialogProps) {
  const t = useTranslations('notebook');
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setIsDeleting(false);
      setError('');
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [open]);

  const handleConfirm = async () => {
    setIsDeleting(true);
    setError('');
    try {
      await onConfirm();
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
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
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
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(event) => {
              event.preventDefault();
              void handleConfirm();
            }}
            disabled={isDeleting}
          >
            {isDeleting && <Loader2 className="h-4 w-4 animate-spin" />}
            {isDeleting ? t('deleting') : t('delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
