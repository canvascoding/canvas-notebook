'use client';

import { ExternalLink, FileImage, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  deriveUploadAttachmentPreview,
  formatAttachmentSize,
  getAttachmentMediaUrl,
  resolvePreviewSrcFromMediaUrl,
  type ChatAttachment,
} from './attachment-preview';

interface AttachmentPreviewDialogProps {
  attachment: ChatAttachment | null;
  onClose: () => void;
}

export function AttachmentPreviewDialog({ attachment, onClose }: AttachmentPreviewDialogProps) {
  const displayAttachment = attachment ? deriveUploadAttachmentPreview(attachment) : null;
  const mediaUrl = displayAttachment ? getAttachmentMediaUrl(displayAttachment) : undefined;
  const previewSrc = mediaUrl
    ? resolvePreviewSrcFromMediaUrl(mediaUrl, 1280)
    : displayAttachment?.previewUrl;
  const sizeLabel = formatAttachmentSize(displayAttachment?.size);
  const details = [
    displayAttachment?.mimeType,
    sizeLabel,
  ].filter(Boolean).join(' / ');

  return (
    <Dialog open={Boolean(displayAttachment)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        layout="viewport"
        showCloseButton={false}
        className="flex h-full flex-col gap-0 p-0"
      >
        <DialogTitle className="sr-only">{displayAttachment?.name || 'Attachment preview'}</DialogTitle>
        <DialogDescription className="sr-only">Uploaded image preview</DialogDescription>

        <div className="flex min-h-14 items-center justify-between gap-2 border-b border-border px-3 py-2 sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <FileImage className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{displayAttachment?.name}</p>
              {details ? <p className="truncate text-xs text-muted-foreground">{details}</p> : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {mediaUrl ? (
              <Button asChild variant="ghost" size="icon-sm" aria-label="Open original">
                <a href={mediaUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4" />
                </a>
              </Button>
            ) : null}
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-3 sm:p-4">
          <div className="flex min-h-full items-center justify-center">
            {previewSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewSrc}
                alt={displayAttachment?.name || ''}
                className={cn(
                  'max-h-[calc(100dvh-9rem)] w-auto max-w-full object-contain',
                  'rounded-md border border-border bg-background shadow-sm',
                )}
                loading="eager"
                decoding="async"
              />
            ) : (
              <div className="border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
                Preview unavailable
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
