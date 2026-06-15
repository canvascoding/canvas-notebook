'use client';

import { FileText, Image as ImageIcon, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  deriveUploadAttachmentPreview,
  formatAttachmentSize,
  getAttachmentMediaUrl,
  type ChatAttachment,
} from '@/app/lib/chat/attachment-preview';

interface AttachmentPreviewItemProps {
  attachment: ChatAttachment;
  context: 'message' | 'composer';
  previewGroup?: ChatAttachment[];
  onRemove?: () => void;
  onOpen?: (attachment: ChatAttachment, previewGroup?: ChatAttachment[]) => void;
}

export function AttachmentPreviewItem({
  attachment,
  context,
  previewGroup,
  onRemove,
  onOpen,
}: AttachmentPreviewItemProps) {
  const displayAttachment = deriveUploadAttachmentPreview(attachment);
  const isImage = displayAttachment.contentKind === 'image' && Boolean(displayAttachment.previewUrl);
  const mediaUrl = getAttachmentMediaUrl(displayAttachment);
  const canOpen = Boolean(isImage && mediaUrl && onOpen);
  const sizeLabel = formatAttachmentSize(displayAttachment.size);
  const wrapperClass = context === 'composer'
    ? 'flex shrink-0 items-center gap-2 border border-border bg-accent/70 p-1 px-2 text-xs'
    : 'flex max-w-full items-center gap-2 border border-border bg-background/50 p-1.5 px-2.5 text-[10px]';

  if (!isImage) {
    return (
      <div
        data-testid={context === 'message' ? 'chat-message-attachment' : 'chat-composer-attachment'}
        className={wrapperClass}
        title={displayAttachment.name}
      >
        <FileText className={context === 'composer' ? 'h-3.5 w-3.5 shrink-0' : 'h-3 w-3 shrink-0'} />
        <span className="min-w-0 truncate">{displayAttachment.name}</span>
        {onRemove ? (
          <button type="button" onClick={onRemove} className="shrink-0 hover:text-destructive" aria-label={`Remove ${displayAttachment.name}`}>
            <X className="h-3 w-3" />
          </button>
        ) : null}
      </div>
    );
  }

  const imageBoxClass = context === 'composer'
    ? 'h-12 w-16'
    : 'h-20 w-28';
  const imageDimensions = context === 'composer'
    ? { width: 64, height: 48 }
    : { width: 112, height: 80 };

  return (
    <div
      data-testid={context === 'message' ? 'chat-message-attachment' : 'chat-composer-attachment'}
      data-attachment-kind="image"
      className={cn(wrapperClass, context === 'message' ? 'max-w-[220px]' : 'max-w-[240px]')}
      title={displayAttachment.name}
    >
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => {
          if (canOpen) {
            onOpen?.(displayAttachment, previewGroup);
          }
        }}
        className={cn(
          imageBoxClass,
          'shrink-0 overflow-hidden rounded-md border border-border/70 bg-muted',
          canOpen ? 'cursor-pointer transition hover:border-primary/40' : 'cursor-default',
        )}
        aria-label={`Open ${displayAttachment.name}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={displayAttachment.previewUrl}
          alt={displayAttachment.name}
          width={imageDimensions.width}
          height={imageDimensions.height}
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          draggable={false}
        />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <ImageIcon className={context === 'composer' ? 'h-3.5 w-3.5 shrink-0' : 'h-3 w-3 shrink-0'} />
          <span className="min-w-0 truncate">{displayAttachment.name}</span>
        </div>
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
          {sizeLabel || 'Preview'}
        </div>
      </div>
      {onRemove ? (
        <button type="button" onClick={onRemove} className="shrink-0 hover:text-destructive" aria-label={`Remove ${displayAttachment.name}`}>
          <X className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}
