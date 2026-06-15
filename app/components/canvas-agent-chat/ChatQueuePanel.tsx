'use client';

import {
  CornerDownRight,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { QueuePreviewItem } from '@/app/lib/chat/types';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

function ChatQueueItem({
  entry,
  isMobile,
  isWebSocketUnavailable,
  openItemId,
  onOpenItemChange,
  onPromote,
  onRemove,
  onEdit,
}: {
  entry: QueuePreviewItem;
  isMobile: boolean;
  isWebSocketUnavailable: boolean;
  openItemId: string | null;
  onOpenItemChange: (entryId: string | null) => void;
  onPromote: (queueItemId: string) => void;
  onRemove: (queueItemId: string) => void;
  onEdit: (entry: QueuePreviewItem) => void;
}) {
  const t = useTranslations('chat');
  const canPromote = entry.kind === 'follow_up' && !isWebSocketUnavailable;
  const label = entry.text || t('imageMessage');

  return (
    <div
      data-testid="chat-queue-item"
      data-queue-kind={entry.kind}
      className={cn(
        'group flex min-h-10 items-center gap-2 border-b border-border/60 px-2.5 py-1.5 last:border-b-0',
        isMobile ? 'text-[13px]' : 'text-sm',
      )}
    >
      <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground/35" aria-hidden="true" />
      <CornerDownRight className="h-4 w-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />
      <button
        type="button"
        onClick={() => {
          if (canPromote) {
            onPromote(entry.id);
          }
        }}
        disabled={!canPromote}
        className="min-w-0 flex-1 truncate text-left text-foreground/75 transition-colors enabled:hover:text-foreground disabled:cursor-default"
        title={label}
      >
        {label}
      </button>
      <button
        type="button"
        data-testid="chat-queue-item-steer"
        onClick={() => onPromote(entry.id)}
        disabled={!canPromote}
        className="inline-flex shrink-0 items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary disabled:cursor-default disabled:opacity-45"
        title={t('steerAction')}
      >
        <CornerDownRight className="h-3.5 w-3.5" />
        <span>{t('steer')}</span>
      </button>
      <button
        type="button"
        data-testid="chat-queue-item-remove"
        onClick={() => onRemove(entry.id)}
        disabled={isWebSocketUnavailable}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
        title={t('removeQueuedMessage')}
      >
        <Trash2 className="h-4 w-4" />
      </button>
      {entry.kind === 'follow_up' && (
        <Popover
          open={openItemId === entry.id}
          onOpenChange={(open) => {
            onOpenItemChange(open ? entry.id : null);
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={isWebSocketUnavailable}
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              title={t('editQueuedMessage')}
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" side="bottom" className="w-44 p-1">
            <button
              type="button"
              onClick={() => onEdit(entry)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent"
            >
              <Pencil size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{t('editQueuedMessage')}</span>
            </button>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

export function ChatQueuePanel({
  items,
  isMobile,
  isWebSocketUnavailable,
  openItemId,
  onOpenItemChange,
  onPromote,
  onRemove,
  onEdit,
}: {
  items: QueuePreviewItem[];
  isMobile: boolean;
  isWebSocketUnavailable: boolean;
  openItemId: string | null;
  onOpenItemChange: (entryId: string | null) => void;
  onPromote: (queueItemId: string) => void;
  onRemove: (queueItemId: string) => void;
  onEdit: (entry: QueuePreviewItem) => void;
}) {
  return (
    <div
      data-testid="chat-queue-panel"
      className={cn(
        'mb-2 overflow-hidden rounded-md border border-border/70 bg-background/95 shadow-sm',
        isMobile ? 'max-h-36' : 'max-h-44',
      )}
    >
      <div className={cn('overflow-y-auto', isMobile ? 'max-h-36' : 'max-h-44')}>
        {items.map((entry) => (
          <ChatQueueItem
            key={`${entry.kind}-${entry.id}`}
            entry={entry}
            isMobile={isMobile}
            isWebSocketUnavailable={isWebSocketUnavailable}
            openItemId={openItemId}
            onOpenItemChange={onOpenItemChange}
            onPromote={onPromote}
            onRemove={onRemove}
            onEdit={onEdit}
          />
        ))}
      </div>
    </div>
  );
}
