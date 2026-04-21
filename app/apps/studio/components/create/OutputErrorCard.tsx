'use client';

import { AlertCircle, RefreshCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useState } from 'react';

interface OutputErrorCardProps {
  mode: 'image' | 'video';
  message?: string | null;
  onDelete?: () => void;
}

export function OutputErrorCard({ mode, message, onDelete }: OutputErrorCardProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const handleDelete = () => {
    setShowDeleteDialog(false);
    onDelete?.();
  };

  return (
    <>
      <div className="flex aspect-square flex-col justify-between rounded-3xl border border-red-500/40 bg-red-500/5 p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-red-700 dark:text-red-300">
            {mode}
          </span>
          <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-300" />
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Generation failed</h3>
          <p className="line-clamp-4 text-sm leading-6 text-muted-foreground">
            {message || 'The output could not be created. Try again with a simplified prompt or a different preset.'}
          </p>
        </div>

        <div className="flex gap-2">
          <Button type="button" variant="outline" className="flex-1 justify-center gap-2" disabled>
            <RefreshCcw className="h-4 w-4" />
            Retry
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-10 justify-center gap-2 text-red-600 hover:bg-red-500/10 hover:text-red-700"
            onClick={() => setShowDeleteDialog(true)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Löschen bestätigen</AlertDialogTitle>
            <AlertDialogDescription>
              Möchtest du diese fehlerhafte Generierung wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
