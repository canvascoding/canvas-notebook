'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, FileImage, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
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
  attachments?: ChatAttachment[];
  onClose: () => void;
}

type ImageLoadState = 'idle' | 'loading' | 'loaded' | 'error';
type ImageLoadSnapshot = {
  attachmentKey: string;
  src?: string;
  state: ImageLoadState;
};
type NavigationSnapshot = {
  attachmentKey: string;
  index: number;
};

function isPreviewableImageAttachment(attachment: ChatAttachment): boolean {
  const displayAttachment = deriveUploadAttachmentPreview(attachment);
  return displayAttachment.contentKind === 'image' && Boolean(getAttachmentMediaUrl(displayAttachment) || displayAttachment.previewUrl);
}

function attachmentIdentity(attachment: ChatAttachment | null): string {
  if (!attachment) {
    return '';
  }

  return [
    attachment.id,
    attachment.mediaUrl,
    attachment.previewUrl,
    attachment.filePath,
    attachment.name,
  ].filter(Boolean).join('|');
}

export function AttachmentPreviewDialog({ attachment, attachments, onClose }: AttachmentPreviewDialogProps) {
  const activeAttachmentKey = attachmentIdentity(attachment);
  const [navigationSnapshot, setNavigationSnapshot] = useState<NavigationSnapshot | null>(null);
  const [imageLoadSnapshot, setImageLoadSnapshot] = useState<ImageLoadSnapshot>({
    attachmentKey: '',
    state: 'idle',
  });
  const imageAttachments = useMemo(() => {
    const sourceAttachments = attachment
      ? (attachments?.length ? attachments : [attachment])
      : [];
    return sourceAttachments
      .map((item) => deriveUploadAttachmentPreview(item))
      .filter(isPreviewableImageAttachment);
  }, [attachment, attachments]);
  const selectedIndex = useMemo(() => {
    if (!activeAttachmentKey) {
      return -1;
    }

    return imageAttachments.findIndex((item) => attachmentIdentity(item) === activeAttachmentKey);
  }, [activeAttachmentKey, imageAttachments]);
  const baseIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const requestedActiveIndex = navigationSnapshot?.attachmentKey === activeAttachmentKey
    ? navigationSnapshot.index
    : baseIndex;
  const activeIndex = imageAttachments.length > 0
    ? Math.min(Math.max(requestedActiveIndex, 0), imageAttachments.length - 1)
    : 0;
  const displayAttachment = imageAttachments[activeIndex] ?? (attachment ? deriveUploadAttachmentPreview(attachment) : null);
  const displayAttachmentKey = attachmentIdentity(displayAttachment);
  const mediaUrl = displayAttachment ? getAttachmentMediaUrl(displayAttachment) : undefined;
  const fullImageSrc = mediaUrl || displayAttachment?.previewUrl;
  const fallbackPreviewSrc = mediaUrl
    ? resolvePreviewSrcFromMediaUrl(mediaUrl, 1920, { preset: 'default' })
    : displayAttachment?.previewUrl;
  const imageSrc = imageLoadSnapshot.attachmentKey === displayAttachmentKey &&
    imageLoadSnapshot.src &&
    (imageLoadSnapshot.src === fullImageSrc || imageLoadSnapshot.src === fallbackPreviewSrc)
    ? imageLoadSnapshot.src
    : fullImageSrc;
  const imageLoadState = imageSrc
    ? (
      imageLoadSnapshot.attachmentKey === displayAttachmentKey && imageLoadSnapshot.src === imageSrc
        ? imageLoadSnapshot.state
        : 'loading'
    )
    : 'idle';
  const sizeLabel = formatAttachmentSize(displayAttachment?.size);
  const details = [
    displayAttachment?.mimeType,
    sizeLabel,
  ].filter(Boolean).join(' / ');
  const canNavigate = imageAttachments.length > 1;
  const detailLine = [
    canNavigate ? `${activeIndex + 1} / ${imageAttachments.length}` : null,
    details,
  ].filter(Boolean).join(' - ');
  const isImageLoading = imageLoadState === 'loading';

  const showPrevious = useCallback(() => {
    if (!canNavigate) {
      return;
    }

    setNavigationSnapshot({
      attachmentKey: activeAttachmentKey,
      index: (activeIndex - 1 + imageAttachments.length) % imageAttachments.length,
    });
  }, [activeAttachmentKey, activeIndex, canNavigate, imageAttachments.length]);

  const showNext = useCallback(() => {
    if (!canNavigate) {
      return;
    }

    setNavigationSnapshot({
      attachmentKey: activeAttachmentKey,
      index: (activeIndex + 1) % imageAttachments.length,
    });
  }, [activeAttachmentKey, activeIndex, canNavigate, imageAttachments.length]);

  useEffect(() => {
    if (!displayAttachment || !canNavigate) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        showPrevious();
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        showNext();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canNavigate, displayAttachment, showNext, showPrevious]);

  const handleImageError = useCallback(() => {
    if (fallbackPreviewSrc && imageSrc !== fallbackPreviewSrc) {
      setImageLoadSnapshot({
        attachmentKey: displayAttachmentKey,
        src: fallbackPreviewSrc,
        state: 'loading',
      });
      return;
    }

    setImageLoadSnapshot({
      attachmentKey: displayAttachmentKey,
      src: imageSrc,
      state: 'error',
    });
  }, [displayAttachmentKey, fallbackPreviewSrc, imageSrc]);

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
              {detailLine ? <p className="truncate text-xs text-muted-foreground">{detailLine}</p> : null}
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
            {imageSrc && imageLoadState !== 'error' ? (
              <div className="relative flex min-h-[52dvh] w-full items-center justify-center">
                {isImageLoading ? (
                  <div data-testid="attachment-preview-skeleton" className="absolute inset-x-0 top-1/2 z-0 mx-auto flex h-[52dvh] max-h-[720px] w-full max-w-5xl -translate-y-1/2 items-center justify-center px-2">
                    <Skeleton className="h-full w-full rounded-md bg-muted" />
                  </div>
                ) : null}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  key={imageSrc}
                  data-testid="attachment-preview-full-image"
                  src={imageSrc}
                  alt={displayAttachment?.name || ''}
                  className={cn(
                    'relative z-10 max-h-[calc(100dvh-9rem)] w-auto max-w-full object-contain transition-opacity duration-150',
                    'rounded-md border border-border bg-background shadow-sm',
                    isImageLoading ? 'opacity-0' : 'opacity-100',
                  )}
                  loading="eager"
                  decoding="async"
                  fetchPriority="high"
                  onLoad={() => setImageLoadSnapshot({
                    attachmentKey: displayAttachmentKey,
                    src: imageSrc,
                    state: 'loaded',
                  })}
                  onError={handleImageError}
                  draggable={false}
                />
                {canNavigate ? (
                  <>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="absolute left-1 top-1/2 z-20 h-10 w-10 -translate-y-1/2 rounded-full bg-background/90 shadow-sm backdrop-blur transition hover:bg-background sm:left-3"
                      onClick={showPrevious}
                      aria-label="Previous image"
                      data-testid="attachment-preview-previous"
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="icon"
                      className="absolute right-1 top-1/2 z-20 h-10 w-10 -translate-y-1/2 rounded-full bg-background/90 shadow-sm backdrop-blur transition hover:bg-background sm:right-3"
                      onClick={showNext}
                      aria-label="Next image"
                      data-testid="attachment-preview-next"
                    >
                      <ChevronRight className="h-5 w-5" />
                    </Button>
                  </>
                ) : null}
              </div>
            ) : imageLoadState === 'error' ? (
              <div className="border border-border bg-background px-4 py-3 text-sm text-muted-foreground">
                Preview unavailable
              </div>
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
