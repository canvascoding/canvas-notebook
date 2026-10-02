'use client';

import { AlertCircle, Copy, Info, Trash2, Wand2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
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
import { useId, useState } from 'react';
import { getStudioGenerationErrorHint } from '../../utils/generation-error-hints';

interface OutputErrorCardProps {
  mode: 'image' | 'video' | 'sound';
  message?: string | null;
  prompt?: string | null;
  onDelete?: () => void;
  onRemix?: (prompt: string) => void;
}

export function OutputErrorCard({ mode, message, prompt, onDelete, onRemix }: OutputErrorCardProps) {
  const t = useTranslations('studio.outputError');
  const promptId = useId();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showDetailsDialog, setShowDetailsDialog] = useState(false);
  const [copied, setCopied] = useState(false);
  const hintKey = getStudioGenerationErrorHint(message);
  const hint = hintKey ? t(hintKey) : null;

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
        className={`flex ${hint ? 'min-h-[260px]' : 'aspect-square'} flex-col justify-between gap-4 rounded-lg border border-destructive/35 bg-destructive/5 p-4 cursor-pointer transition-colors hover:bg-destructive/10`}
        onClick={() => setShowDetailsDialog(true)}
      >
        <div className="flex items-center justify-between">
          <span className="rounded-md border border-border bg-background/60 px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {t(`mode.${mode}`)}
          </span>
          <AlertCircle aria-hidden="true" className="h-4 w-4 text-destructive" />
        </div>

        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
          <p
            className={`${hint ? 'line-clamp-2' : 'line-clamp-4'} break-words text-sm leading-6 text-muted-foreground`}
            title={message || undefined}
          >
            {message || t('description')}
          </p>
          {hint ? (
            <p className="border-l-2 border-warning/40 pl-2 text-xs leading-5 text-muted-foreground">
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
            <Info aria-hidden="true" className="h-4 w-4" />
            {t('details')}
          </Button>
          {onDelete ? <Button
            type="button"
            variant="outline"
            aria-label={t('delete')}
            className="w-10 justify-center gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation();
              setShowDeleteDialog(true);
            }}
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </Button> : null}
        </div>
      </div>

      <Dialog open={showDetailsDialog} onOpenChange={setShowDetailsDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>
              {t(prompt ? 'detailsDescription' : 'description')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <InlineNotice variant="destructive" size="compact" title={t('errorLabel')}>
              <p className="max-h-48 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
                {message || t('unknownError')}
              </p>
              {hint ? <p>{hint}</p> : null}
            </InlineNotice>

            {prompt && (
              <div className="space-y-2">
                <label htmlFor={promptId} className="text-sm font-medium">{t('originalPrompt')}</label>
                <textarea
                  id={promptId}
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
                <Copy aria-hidden="true" className="h-4 w-4" />
                {copied ? t('copied') : t('copy')}
              </Button>
            )}
            {prompt && onRemix && (
              <Button
                type="button"
                className="gap-2"
                onClick={handleRemix}
              >
                <Wand2 aria-hidden="true" className="h-4 w-4" />
                {t('remix')}
              </Button>
            )}
            {onDelete ? <Button
              type="button"
              variant="outline"
              className="gap-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setShowDeleteDialog(true)}
            >
              <Trash2 aria-hidden="true" className="h-4 w-4" />
              {t('delete')}
            </Button> : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('deleteDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
