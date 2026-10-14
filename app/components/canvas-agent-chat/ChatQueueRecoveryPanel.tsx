'use client';

import { useState } from 'react';
import { AlertTriangle, ChevronRight, CornerDownRight, Loader2, MoreHorizontal, Pencil, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ChatQueueRecoveryStatus } from '@/app/lib/chat/queue-recovery';
import type { RuntimeQueueItem } from '@/app/lib/chat/runtime-status';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

type Props = { queue: ChatQueueRecoveryStatus | null; loading: boolean; error: string | null; pendingId: string | null;
  runtimeBusy: boolean; actionsDisabled?: boolean; onRefresh: () => void; onControl: (item: RuntimeQueueItem, action: 'resume' | 'cancel') => void;
  onPromote?: (item: RuntimeQueueItem) => void; onEdit?: (item: RuntimeQueueItem) => void;
  onNewChat: () => void };

export function ChatQueueRecoveryPanel({ queue, loading, error, pendingId, runtimeBusy, actionsDisabled, onRefresh, onControl, onPromote, onEdit, onNewChat }: Props) {
  const t = useTranslations('chat');
  const [openItem, setOpenItem] = useState<RuntimeQueueItem | null>(null);
  const items = [...(queue?.items ?? [])].sort((left, right) => (left.queue?.ordinal ?? Number.MAX_SAFE_INTEGER)
    - (right.queue?.ordinal ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id));
  const blocked = queue?.blocked ?? [];
  const unresolved = blocked.filter(item => item.reason !== 'unknown_queue_position');
  const hasReady = !runtimeBusy && items.some(item => item.queue?.disposition === 'ready');
  if (!loading && !error && !items.length && !blocked.length) return null;
  const problem = Boolean(error || blocked.length);
  const blockerLabel = blocked.some(item => item.reason === 'outcome_unknown') ? t('queueRecoveryUnknown')
    : blocked.some(item => item.reason === 'legacy') ? t('queueRecoveryLegacy')
      : blocked.some(item => item.reason === 'execution_in_progress') ? t('queueRecoveryInProgress') : t('queueRecoveryPosition');
  return <section data-testid="chat-queue-recovery" aria-label={t('queueRecoveryTitle')}
    className="mb-2 overflow-hidden rounded-md border border-border/70 bg-muted/15 text-xs">
    <div className="flex items-start gap-2 px-3 py-2" role={problem ? 'alert' : 'status'} aria-live="polite">
      {loading ? <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        : <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
      <div className="min-w-0 flex-1 space-y-1">
        <p>{error ? t('queueRecoveryError', { message: error }) : blocked.length ? blockerLabel
          : loading ? t('queueRecoveryLoading') : hasReady ? t('queueRecoveryReady')
            : t('queueRecoveryCount', { count: items.length })}</p>
        {unresolved.length > 0 && <p className="text-muted-foreground">{t('queueRecoveryNoRepeat')}</p>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button type="button" onClick={onRefresh} disabled={loading || Boolean(pendingId)}
            className="inline-flex items-center gap-1 font-medium text-primary disabled:opacity-50">
            <RefreshCw className="size-3" aria-hidden="true" />{t('queueRecoveryRefresh')}
          </button>
          {unresolved.length > 0 && <button type="button" onClick={onNewChat} className="font-medium text-primary">{t('newChatTitle')}</button>}
        </div>
      </div>
    </div>
    {(items.length > 0 || blocked.length > 0) && <details className="group border-t border-border/60">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-muted-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
        {t('queueRecoveryDetails', { count: items.length + unresolved.length })}
      </summary>
      <div className="max-h-48 overflow-y-auto border-t border-border/60">
        {unresolved.map(item => <div key={`${item.reason}:${item.clientMessageId}`} className="space-y-0.5 px-3 py-2" data-testid="chat-queue-blocker" data-reason={item.reason}>
          <p>{item.reason === 'legacy' ? t('queueRecoveryLegacy') : item.reason === 'outcome_unknown' ? t('queueRecoveryUnknown') : t('queueRecoveryInProgress')}</p>
          <p className="break-all font-mono text-[10px] text-muted-foreground">{item.clientMessageId}</p>
        </div>)}
        {items.map(item => {
          const forbidden = blocked.some(blocker => blocker.clientMessageId === item.clientMessageId && blocker.reason !== 'unknown_queue_position');
          const canResume = !unresolved.length && !forbidden && Number.isSafeInteger(item.executionRevision)
            && (item.queue === null || item.queue?.disposition === 'suspended' || !runtimeBusy);
          const canUseExistingActions = !unresolved.length && item.queue && ['prompt', 'follow_up'].includes(item.queue.lane);
          const disabled = actionsDisabled || loading || Boolean(pendingId);
          return <div key={item.id} data-testid="chat-queue-recovery-item" data-queue-id={item.id}
            data-queue-disposition={item.queue?.disposition ?? 'unpositioned'} className="flex items-start gap-2 border-t border-border/50 px-3 py-2 first:border-t-0">
            <div className="min-w-0 flex-1">
              <p className="line-clamp-2 whitespace-pre-wrap break-words text-foreground/85">{item.text || t('imageMessage')}</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">{item.queue === null ? t('queueRecoveryPositionLabel')
                : item.queue?.disposition === 'suspended' ? t('queueRecoverySuspended') : t('queueRecoveryWaiting')}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {canResume && <button type="button" onClick={() => onControl(item, 'resume')} disabled={actionsDisabled || loading || Boolean(pendingId)}
                className="font-medium text-primary disabled:opacity-50">{pendingId === item.id ? t('queueRecoveryUpdating') : t('queueRecoveryResume')}</button>}
              {!forbidden && <button type="button" onClick={() => onControl(item, 'cancel')} disabled={actionsDisabled || loading || Boolean(pendingId)}
                className="text-muted-foreground hover:text-destructive disabled:opacity-50">{t('queueRecoveryCancel')}</button>}
              {canUseExistingActions && (onPromote || onEdit) && <Popover open={openItem === item && !disabled}
                onOpenChange={open => setOpenItem(open ? item : null)}>
                <PopoverTrigger asChild><button type="button" disabled={disabled} aria-label={t('queueRecoveryMore')}
                  className="inline-flex size-7 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-50">
                  <MoreHorizontal className="size-4" aria-hidden="true" />
                </button></PopoverTrigger>
                <PopoverContent align="end" className="w-44 p-1">
                  {onPromote && <button type="button" disabled={disabled} onClick={() => { setOpenItem(null); onPromote(item); }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent disabled:opacity-50">
                    <CornerDownRight className="size-3.5" aria-hidden="true" />{t('steerAction')}
                  </button>}
                  {onEdit && <button type="button" disabled={disabled} onClick={() => { setOpenItem(null); onEdit(item); }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent disabled:opacity-50">
                    <Pencil className="size-3.5" aria-hidden="true" />{t('editQueuedMessage')}
                  </button>}
                </PopoverContent>
              </Popover>}
            </div>
          </div>;
        })}
      </div>
    </details>}
  </section>;
}
