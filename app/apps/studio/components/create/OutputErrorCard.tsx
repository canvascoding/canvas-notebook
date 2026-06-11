'use client';

import { AlertCircle, Copy, RefreshCcw, Trash2, Wand2 } from 'lucide-react';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useState } from 'react';
import { getStudioGenerationErrorHint } from '../../utils/generation-error-hints';

interface OutputErrorCardProps {
  mode: 'image' | 'video' | 'sound';
  message?: string | null;
  prompt?: string | null;
  onDelete?: () => void;
  onRemix?: (prompt: string) => void;
}

export function OutputErrorCard({ mode, message, prompt, onDelete, onRemix }: OutputErrorCardProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showDetailsDialog, setShowDetailsDialog] = useState(false);
  const [copied, setCopied] = useState(false);
  const hint = getStudioGenerationErrorHint(message);

  const handleDelete = () => {
    setShowDeleteDialog(false);
    onDelete?.();
  };

  const handleCopyPrompt = async () => {
    if (!prompt) return;
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRemix = () => {
    if (!prompt) return;
    setShowDetailsDialog(false);
    onRemix?.(prompt);
  };

  return (
    <>
      <div
        className={`flex ${hint ? 'min-h-[260px]' : 'aspect-square'} flex-col justify-between rounded-3xl border border-red-500/40 bg-red-500/5 p-4 shadow-sm cursor-pointer transition-colors hover:bg-red-500/10`}
        onClick={() => setShowDetailsDialog(true)}
      >
        <div className="flex items-center justify-between">
          <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-red-700 dark:text-red-300">
            {mode}
          </span>
          <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-300" />
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Generation failed</h3>
          <p
            className={`${hint ? 'line-clamp-2' : 'line-clamp-4'} break-words text-sm leading-6 text-muted-foreground`}
            title={message || undefined}
          >
            {message || 'The output could not be created. Try again with a simplified prompt or a different preset.'}
          </p>
          {hint ? (
            <p className="border-l-2 border-amber-500/70 pl-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
              {hint}
            </p>
          ) : null}
        </div>

        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="flex-1 justify-center gap-2"
            onClick={(e) => {
              e.stopPropagation();
              setShowDetailsDialog(true);
            }}
          >
            <RefreshCcw className="h-4 w-4" />
            Remix
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-10 justify-center gap-2 text-red-600 hover:bg-red-500/10 hover:text-red-700"
            onClick={(e) => {
              e.stopPropagation();
              setShowDeleteDialog(true);
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <Dialog open={showDetailsDialog} onOpenChange={setShowDetailsDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertCircle className="h-5 w-5" />
              Generation konnte nicht abgeschlossen werden
            </DialogTitle>
            <DialogDescription>
              Die Generierung ist fehlgeschlagen. Der ursprüngliche Prompt ist unten verfügbar und kann kopiert oder remixt werden.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
              <p className="text-sm font-medium text-red-700 dark:text-red-300">Fehler:</p>
              <p className="text-sm text-muted-foreground">
                {message || 'Unbekannter Fehler bei der Generierung.'}
              </p>
            </div>

            {prompt && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Ursprünglicher Prompt:</label>
                <textarea
                  readOnly
                  value={prompt}
                  className="min-h-[120px] w-full rounded-lg border border-border bg-muted/50 p-3 text-sm leading-relaxed text-foreground"
                />
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            {prompt && (
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                onClick={handleCopyPrompt}
              >
                <Copy className="h-4 w-4" />
                {copied ? 'Kopiert!' : 'Kopieren'}
              </Button>
            )}
            {prompt && onRemix && (
              <Button
                type="button"
                className="gap-2"
                onClick={handleRemix}
              >
                <Wand2 className="h-4 w-4" />
                Remixen
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              className="gap-2 text-red-600 hover:bg-red-500/10 hover:text-red-700"
              onClick={() => setShowDeleteDialog(true)}
            >
              <Trash2 className="h-4 w-4" />
              Löschen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
