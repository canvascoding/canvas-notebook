'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, FileText, Loader2, TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { MarkdownRenderer } from '@/app/components/shared/MarkdownRenderer';
import { openWorkspaceMarkdownPath } from '@/app/lib/markdown/workspace-markdown-navigation-client';
import {
  buildWorkspaceDocumentPreviewTarget,
  createWorkspaceDocumentPreviewContent,
  type WorkspaceDocumentPreviewContent,
  type WorkspaceDocumentReference,
} from '@/app/lib/markdown/workspace-document-preview';
import { loadWorkspaceMarkdownEmbed } from '@/app/lib/markdown/workspace-link-index-client';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type PreviewState = {
  error: string | null;
  key: string;
  preview: WorkspaceDocumentPreviewContent | null;
};

type WorkspaceDocumentPreviewDialogProps = {
  onOpenChange: (open: boolean) => void;
  onOpenDocument?: (reference: WorkspaceDocumentReference) => Promise<void> | void;
  open: boolean;
  reference: WorkspaceDocumentReference | null;
};

export function WorkspaceDocumentPreviewDialog({
  onOpenChange,
  onOpenDocument,
  open,
  reference,
}: WorkspaceDocumentPreviewDialogProps) {
  const t = useTranslations('notebook');
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const [state, setState] = useState<PreviewState | null>(null);
  const [openingDocument, setOpeningDocument] = useState(false);
  const requestKey = reference
    ? `${workspaceId ?? ''}\0${reference.path}\0${reference.heading ?? ''}\0${reference.blockId ?? ''}\0${reference.focusOffset ?? ''}`
    : '';

  useEffect(() => {
    if (!open || !reference || !workspaceId) return undefined;
    let cancelled = false;
    const target = buildWorkspaceDocumentPreviewTarget(reference);
    void loadWorkspaceMarkdownEmbed(workspaceId, target)
      .then((document) => {
        if (cancelled) return;
        setState({
          error: null,
          key: requestKey,
          preview: createWorkspaceDocumentPreviewContent(document.content, reference),
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({
          error: error instanceof Error ? error.message : t('markdownDocumentPreviewLoadError'),
          key: requestKey,
          preview: null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [open, reference, requestKey, t, workspaceId]);

  const currentState = state?.key === requestKey ? state : null;
  const locationLabel = useMemo(() => {
    if (reference?.blockId) return `^${reference.blockId}`;
    if (reference?.heading) return reference.heading;
    return null;
  }, [reference]);

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) setOpeningDocument(false);
    onOpenChange(nextOpen);
  };

  const handleOpenDocument = async () => {
    if (!reference || openingDocument) return;
    setOpeningDocument(true);
    try {
      if (onOpenDocument) {
        await onOpenDocument(reference);
      } else {
        const result = await openWorkspaceMarkdownPath({
          blockId: reference.blockId,
          heading: reference.heading,
          path: reference.path,
          workspaceId,
        });
        if (!['opened', 'superseded'].includes(result.status)) {
          throw new Error(result.error ?? t('markdownEditorLinkOpenError'));
        }
      }
      handleDialogOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('markdownEditorLinkOpenError'));
    } finally {
      setOpeningDocument(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="flex max-h-[min(82dvh,52rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border/60 bg-muted/20 px-5 py-4 pr-12">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background text-muted-foreground shadow-sm">
              <FileText className="h-4 w-4" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <DialogTitle className="truncate text-base leading-6">
                {reference?.title || t('markdownDocumentPreviewTitle')}
              </DialogTitle>
              <DialogDescription className="mt-0.5 truncate font-mono text-[11px]">
                {reference?.path || t('markdownDocumentPreviewUnavailable')}
              </DialogDescription>
              {locationLabel ? (
                <span className="mt-1 inline-flex max-w-full rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                  <span className="truncate">{locationLabel}</span>
                </span>
              ) : null}
            </span>
          </div>
        </DialogHeader>

        <div className="min-h-48 flex-1 overflow-y-auto overscroll-contain px-5 py-5">
          {!workspaceId ? (
            <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
              <TriangleAlert className="h-4 w-4" aria-hidden="true" />
              {t('markdownDocumentPreviewUnavailable')}
            </div>
          ) : !currentState ? (
            <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t('markdownDocumentPreviewLoading')}
            </div>
          ) : currentState.error ? (
            <div className="flex min-h-40 items-center justify-center gap-2 rounded-xl border border-destructive/25 bg-destructive/5 px-4 text-sm text-destructive">
              <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
              {currentState.error}
            </div>
          ) : currentState.preview?.content ? (
            <MarkdownRenderer
              content={currentState.preview.content}
              sourcePath={reference?.path}
              className="text-sm leading-6 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-base [&_h3]:font-semibold"
            />
          ) : (
            <p className="flex min-h-40 items-center justify-center text-sm text-muted-foreground">
              {t('markdownDocumentPreviewEmpty')}
            </p>
          )}
        </div>

        <DialogFooter className="items-center border-t border-border/60 bg-muted/15 px-5 py-3 sm:justify-between">
          <p className="min-h-5 text-left text-[11px] text-muted-foreground">
            {currentState?.preview?.truncated ? t('markdownDocumentPreviewTruncated') : null}
          </p>
          <Button onClick={() => void handleOpenDocument()} disabled={!reference || openingDocument || !workspaceId}>
            {openingDocument ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
            {t('markdownDocumentPreviewOpen')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
