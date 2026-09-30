'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ChevronUp, Loader2, MessageSquareText, Send } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  fetchChatDelegationSteeringReceipt,
  fetchChatDelegationTranscript,
  sendChatDelegationSteering,
  type ChatDelegation,
  type ChatDelegationProgressEvent,
  type ChatDelegationSteeringReceipt,
  type ChatDelegationTranscriptMessage,
} from '@/app/lib/chat/delegation-api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

const MAX_DISPLAY_TEXT = 16_000;

function messageText(message: ChatDelegationTranscriptMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content.slice(0, MAX_DISPLAY_TEXT);
  if (!Array.isArray(content)) return '';
  const lines = content.flatMap((part: unknown) => {
    if (!part || typeof part !== 'object') return [];
    const block = part as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') return [block.text];
    if (block.type === 'toolCall' && typeof block.name === 'string') return [`→ ${block.name}`];
    return [];
  });
  return lines.join('\n\n').slice(0, MAX_DISPLAY_TEXT);
}

export function ChatDelegationDetail({
  task,
  events,
  canSteer,
  open,
  onOpenChange,
}: {
  task: ChatDelegation;
  events: ChatDelegationProgressEvent[];
  canSteer: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('chat');
  const [messages, setMessages] = useState<ChatDelegationTranscriptMessage[]>([]);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [oldestSequence, setOldestSequence] = useState<number | null>(null);
  const [oldestMessageId, setOldestMessageId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [steeringText, setSteeringText] = useState('');
  const [steeringError, setSteeringError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<ChatDelegationSteeringReceipt | null>(null);
  const pendingRequestRef = useRef<{ text: string; id: string } | null>(null);
  const agentId = task.targetAgentId ?? task.sourceAgentId;

  const loadMessages = useCallback(async (older = false, signal?: AbortSignal) => {
    if (older) setLoadingOlder(true);
    else setLoading(true);
    setLoadError(null);
    try {
      const page = await fetchChatDelegationTranscript({
        id: task.id,
        workerSessionId: task.workerSessionId,
        agentId,
        sourceSessionId: task.sourceSessionId,
        beforeSequence: older ? oldestSequence ?? undefined : undefined,
        beforeId: older ? oldestMessageId ?? undefined : undefined,
        signal,
      });
      if (signal?.aborted) return;
      setMessages((current) => older
        ? [...page.messages.filter((message) => !current.some((known) => known.id === message.id)), ...current]
        : page.messages);
      setHasMoreBefore(page.hasMoreBefore);
      setOldestSequence(page.oldestSequence);
      setOldestMessageId(page.oldestMessageId);
    } catch (error) {
      if (!signal?.aborted) setLoadError(error instanceof Error ? error.message : t('delegationDetailTranscriptFailed'));
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
        setLoadingOlder(false);
      }
    }
  }, [agentId, oldestMessageId, oldestSequence, task.id, task.sourceSessionId, task.workerSessionId, t]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => { void loadMessages(false, controller.signal); }, 0);
    return () => { controller.abort(); window.clearTimeout(timeout); };
    // Load once for this open task. Pagination is requested explicitly below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task.id]);

  useEffect(() => {
    if (!open || task.status !== 'running') return;
    const controller = new AbortController();
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadMessages(false, controller.signal);
    }, 8_000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [loadMessages, open, task.status]);

  useEffect(() => {
    if (!open || !receipt || receipt.status !== 'accepted') return;
    const controller = new AbortController();
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void fetchChatDelegationSteeringReceipt({
        id: task.id, sourceSessionId: task.sourceSessionId, receiptId: receipt.id, signal: controller.signal,
      }).then(setReceipt).catch(() => {});
    }, 3_000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [open, receipt, task.id, task.sourceSessionId]);

  const sendSteering = useCallback(async () => {
    const text = steeringText.trim();
    if (!text || !canSteer) return;
    const pending = pendingRequestRef.current;
    const requestId = pending?.text === text ? pending.id : crypto.randomUUID();
    pendingRequestRef.current = { text, id: requestId };
    setSending(true);
    setSteeringError(null);
    try {
      const nextReceipt = await sendChatDelegationSteering({
        id: task.id, sourceSessionId: task.sourceSessionId, message: text, requestId,
      });
      setReceipt(nextReceipt);
      setSteeringText('');
      pendingRequestRef.current = null;
    } catch (error) {
      setSteeringError(error instanceof Error ? error.message : t('delegationDetailSteeringFailed'));
    } finally {
      setSending(false);
    }
  }, [canSteer, steeringText, task.id, task.sourceSessionId, t]);

  const latestEvents = useMemo(() => [...events].slice(-20).reverse(), [events]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="delegation-detail" className="flex h-[min(90dvh,760px)] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="shrink-0 border-b border-border/70 px-4 py-4 pr-12">
          <DialogTitle className="line-clamp-2 text-left text-base">{task.goal}</DialogTitle>
          <DialogDescription className="text-left text-xs">{t('delegationDetailDescription')}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          <section aria-label={t('delegationDetailSteps')}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('delegationDetailSteps')}</h3>
            {latestEvents.length === 0 ? <p className="text-xs text-muted-foreground">{t('delegationDetailNoStep')}</p> : (
              <ol className="space-y-1.5 border-l border-border/70 pl-3">
                {latestEvents.map((event) => (
                  <li key={event.revision} className="flex gap-2 text-xs">
                    <time className="shrink-0 text-muted-foreground" dateTime={event.createdAt}>
                      {new Date(event.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                    </time>
                    <span>{t(`delegationDetailEvent_${event.kind}`)}{event.preview ? `: ${event.preview}` : ''}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section aria-label={t('delegationDetailTranscript')}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('delegationDetailTranscript')}</h3>
              <Button type="button" variant="ghost" size="xs" onClick={() => void loadMessages()} disabled={loading}>
                {loading ? <Loader2 className="animate-spin" /> : <MessageSquareText />}
                {t('delegationDetailRefresh')}
              </Button>
            </div>
            {hasMoreBefore ? (
              <Button type="button" variant="outline" size="xs" onClick={() => void loadMessages(true)} disabled={loadingOlder} className="mb-2">
                {loadingOlder ? <Loader2 className="animate-spin" /> : <ChevronUp />}
                {t('delegationDetailOlder')}
              </Button>
            ) : null}
            {loadError ? <p role="alert" className="mb-2 flex items-center gap-1 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5" />{loadError}</p> : null}
            {loading && messages.length === 0 ? <p className="text-xs text-muted-foreground">{t('delegationDetailLoading')}</p> : null}
            {!loading && messages.length === 0 && !loadError ? <p className="text-xs text-muted-foreground">{t('delegationDetailNoMessages')}</p> : null}
            <div className="space-y-2" data-testid="chat-delegation-transcript">
              {messages.map((message) => {
                const text = messageText(message);
                return (
                  <article key={message.id} className="rounded-md border border-border/70 bg-muted/20 px-3 py-2">
                    <div className="mb-1 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      <span>{message.role === 'toolResult' ? (message.toolName || t('delegationDetailTool')) : message.role}</span>
                      <span>#{message.sequence}</span>
                    </div>
                    <div className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">{text || t('delegationDetailNonText')}</div>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
        {task.status === 'running' ? (
          <div className="shrink-0 space-y-2 border-t border-border/70 bg-background px-4 py-3">
            <label className="block text-xs font-medium" htmlFor={`delegation-steering-${task.id}`}>{t('delegationDetailSteer')}</label>
            <Textarea id={`delegation-steering-${task.id}`} data-testid={`delegation-steer-input-${task.id}`} value={steeringText} onChange={(event) => setSteeringText(event.target.value)} disabled={!canSteer} maxLength={4_000} placeholder={canSteer ? t('delegationDetailSteerPlaceholder') : t('delegationDetailSteerUnavailable')} className="min-h-16 resize-y text-xs" />
            <div className="flex items-center justify-between gap-2">
              <div aria-live="polite" className="text-xs text-muted-foreground">
                {steeringError ? <span className="text-destructive">{steeringError}</span> : receipt ? t(`delegationDetailReceipt_${receipt.status}`) : null}
              </div>
              <Button type="button" size="sm" data-testid={`delegation-steer-${task.id}`} disabled={sending || !canSteer || !steeringText.trim()} onClick={() => void sendSteering()}>
                {sending ? <Loader2 className="animate-spin" /> : <Send />}
                {t('delegationDetailSend')}
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
