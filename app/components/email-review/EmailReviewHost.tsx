'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertCircle, Check, ChevronDown, PanelLeft, Type, ExternalLink, Inbox, Loader2, Mail, Paperclip, RefreshCw, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import { emailReviewKey, emailReviewTarget } from '@/app/lib/email/review-client';
import {
  useEmailReviewStore, openEmailReview, closeEmailReview, selectEmailReview,
  updateEmailReviewForm, saveActiveEmailReview, sendActiveEmailReview, rejectActiveEmailReview,
  postponeActiveEmailReview, refreshEmailReview, setEmailReviewFilter,
  confirmDiscardEmailReviewNavigation, cancelEmailReviewNavigation,
} from '@/app/store/email-review-store';

const EmailHtmlEditor = dynamic(() => import('@/app/apps/email/components/EmailHtmlEditor').then((module) => module.EmailHtmlEditor), { ssr: false });

export function EmailReviewHost() {
  const t = useTranslations('emailReview');
  const state = useEmailReviewStore();
  const params = useSearchParams();
  const handledLink = useRef<string | null>(null);
  const [mobileList, setMobileList] = useState(false);
  const [queueVisible, setQueueVisible] = useState(true);
  const [showFormatting, setShowFormatting] = useState(false);
  const entry = state.activeEntry;
  const failed = state.queue.filter((item) => item.status === 'send_failed' || item.status === 'send_uncertain');
  const queue = state.filter === 'failed' ? failed : state.queue;
  const locked = !entry?.canWrite || ['sending', 'sent', 'discarded', 'send_uncertain'].includes(entry?.status || '');
  const disabled = locked || state.busy || state.loading || state.needsReload;

  useEffect(() => {
    const draftId = params.get('outboxDraft')?.trim();
    if (!draftId) { handledLink.current = null; return; }
    const workspaceId = params.get('workspaceId')?.trim() || undefined;
    const key = `${workspaceId || 'personal'}:${draftId}`;
    if (handledLink.current === key) return;
    handledLink.current = key;
    setMobileList(false);
    void openEmailReview({ draftId, scope: workspaceId ? 'workspace' : 'personal', workspaceId });
  }, [params]);

  useEffect(() => {
    if (!state.open || !state.dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [state.open, state.dirty]);

  return <>
    <Dialog open={state.open} onOpenChange={(open) => { if (!open) closeEmailReview(); }}>
      <DialogContent data-testid="email-review-host" onOpenAutoFocus={() => setMobileList(false)} showCloseButton={false} className="flex h-[96dvh] max-h-[58rem] min-h-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl" aria-describedby="email-review-description">
        <DialogHeader className="shrink-0 border-b px-4 py-2 text-left sm:px-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-2"><Button data-testid="email-review-toggle-queue" variant="ghost" size="icon" className="hidden md:inline-flex" aria-label={t('toggleQueue')} aria-expanded={queueVisible} onClick={() => setQueueVisible(!queueVisible)}><PanelLeft /></Button><Button data-testid="email-review-mobile-queue" variant="ghost" size="sm" className="md:hidden" aria-label={t('backToQueue')} aria-expanded={mobileList} onClick={() => setMobileList(!mobileList)}><PanelLeft /><span className="tabular-nums">{state.queue.length}</span></Button><Mail className="size-5 text-muted-foreground" /><DialogTitle>{t('title')}</DialogTitle></div>
            <Button variant="ghost" size="icon" aria-label={t('close')} disabled={state.busy} onClick={() => closeEmailReview()}><X /></Button>
          </div>
          <DialogDescription className="sr-only" id="email-review-description">{t('description')}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1">
          <aside className={cn('w-full shrink-0 flex-col border-r bg-muted/25 md:w-64 lg:w-72', queueVisible ? 'md:flex' : 'md:hidden', mobileList ? 'flex' : 'hidden')}>
            <div className="flex items-center gap-2 border-b p-3">
              <Button data-testid="email-review-filter-all" size="sm" variant={state.filter === 'all' ? 'secondary' : 'ghost'} disabled={state.busy || state.loading} onClick={() => setEmailReviewFilter('all')}>{t('all')} <span className="tabular-nums">{state.queue.length}</span></Button>
              <Button data-testid="email-review-filter-failed" size="sm" variant={state.filter === 'failed' ? 'secondary' : 'ghost'} disabled={state.busy || state.loading} onClick={() => setEmailReviewFilter('failed')}>{t('failed')} <span className="tabular-nums">{failed.length}</span></Button>
              <Button className="ml-auto" variant="ghost" size="icon" aria-label={t('refresh')} disabled={state.busy || state.loading} onClick={() => void refreshEmailReview()}><RefreshCw className={cn('size-4', state.loading && 'animate-spin')} /></Button>
            </div>
            <nav data-testid="email-review-queue" aria-label={t('queue')} className="min-h-0 flex-1 overflow-y-auto p-2">
              {queue.map((item) => {
                const selected = entry && emailReviewKey(entry) === emailReviewKey(item);
                const hasError = item.status === 'send_failed' || item.status === 'send_uncertain';
                return <button key={emailReviewKey(item)} data-testid={`email-review-draft-${item.id}`} type="button" aria-current={selected ? 'true' : undefined} disabled={state.busy} onClick={() => { selectEmailReview(emailReviewTarget(item)); setMobileList(false); }} className={cn('mb-1 w-full rounded-lg border border-transparent px-3 py-3 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50', selected && 'border-border bg-background shadow-sm')}>
                  <div className="flex items-start gap-2"><span className="min-w-0 flex-1 truncate text-sm font-medium">{item.subject || t('noSubject')}</span>{hasError && <AlertCircle className="size-4 shrink-0 text-destructive" aria-label={t('failed')} />}</div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{item.to.join(', ') || t('noRecipients')}</p>
                  <p className="mt-2 truncate text-xs text-muted-foreground">{item.senderAddress || t('unknownSender')}</p>
                  <span className="mt-2 inline-block rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{item.scope === 'workspace' ? item.workspaceName || t('workspace') : t('personal')}</span>
                </button>;
              })}
              {!queue.length && !state.loading && <p className="px-3 py-8 text-center text-sm text-muted-foreground">{state.filter === 'failed' ? t('noFailures') : t('empty')}</p>}
            </nav>
          </aside>
          <section className={cn('min-w-0 flex-1 flex-col', mobileList ? 'hidden md:flex' : 'flex')} aria-label={t('message')}>
            {entry && state.form && <div data-testid="email-review-summary" className="shrink-0 border-b bg-background px-4 py-2 sm:px-6">
              <div className="flex min-w-0 items-center gap-2 text-xs"><span className="sr-only shrink-0 text-muted-foreground sm:not-sr-only">{t('sendingFrom')}</span><span className="truncate font-medium" title={entry.senderAddress || undefined}>{entry.senderAddress || t('unknownSender')}</span><span className="ml-auto shrink-0 text-muted-foreground tabular-nums">{Math.max(1, queue.findIndex((item) => emailReviewKey(item) === emailReviewKey(entry)) + 1)} / {queue.length}</span></div>
              <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground"><span className="shrink-0">{t('to')}</span><span className="truncate" title={state.form.toText}>{state.form.toText || t('noRecipients')}</span>{state.form.ccText && <span className="shrink-0 rounded bg-muted px-1" title={state.form.ccText}>CC</span>}{state.form.bccText && <span className="shrink-0 rounded bg-muted px-1" title={state.form.bccText}>BCC</span>}</div>
              <div className="mt-2 flex items-center gap-2"><Label className="sr-only" htmlFor="email-review-subject">{t('subject')}</Label><Input className="h-8 font-medium" id="email-review-subject" data-testid="email-review-subject" value={state.form.subject} disabled={disabled} onChange={(event) => updateEmailReviewForm({ subject: event.target.value })} /></div>
              {(entry.errorMessage || entry.status === 'send_uncertain') && <div data-testid="email-review-policy-error" role="alert" className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium text-destructive"><AlertCircle className="size-4 shrink-0" /><span className="min-w-0 flex-1 break-words">{entry.status === 'send_uncertain' ? t('uncertainTitle') : entry.errorCode === 'SEND_POLICY_BLOCKED' ? t('policyTitle') : t('sendFailedTitle')}</span>{entry.errorCode === 'SEND_POLICY_BLOCKED' && <Link className="w-full break-words pl-6 underline underline-offset-4" href="/settings?tab=system-email" target="_blank" rel="noopener noreferrer">{t('openPolicySettings')}<ExternalLink className="ml-1 inline size-3" /></Link>}</div>}
            </div>}
            {state.error && <div data-testid="email-review-error" role="alert" className="max-h-16 shrink-0 overflow-y-auto border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive sm:px-6">{state.error}</div>}
            <div data-testid="email-review-content" className="min-h-0 flex-1 overflow-y-auto p-4 sm:px-6 sm:py-3">
              {state.loading && <div role="status" className="flex items-center justify-center gap-2 py-12 text-muted-foreground"><Loader2 className="size-5 animate-spin" />{t('loading')}</div>}
              {state.loadingWarnings.map((warning, index) => <p key={index} role="alert" className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">{warning}</p>)}
              {state.needsReload && <div role="alert" className="mb-4 rounded-lg border bg-muted/30 p-3 text-sm"><p>{t('reloadRequired')}</p><Button data-testid="email-review-reload" className="mt-2" size="sm" variant="outline" disabled={state.busy || state.loading} onClick={() => void refreshEmailReview()}><RefreshCw className="size-4" />{t('refresh')}</Button></div>}
              {!entry && !state.loading && <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center"><div className="rounded-full bg-muted p-4">{state.completed ? <Check className="size-7" /> : <Inbox className="size-7 text-muted-foreground" />}</div><h3 className="font-medium">{state.completed ? t('completed') : t('empty')}</h3><p className="max-w-sm text-sm text-muted-foreground">{t('emptyDescription')}</p></div>}
              {entry && state.form && <div className="space-y-3">
                <details key={`${emailReviewKey(entry)}-recipients`} className="group rounded-md border">
                  <summary data-testid="email-review-recipient-details" className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ChevronDown className="size-3 transition-transform group-open:rotate-180" />{t('recipientDetails')}<span className="ml-auto truncate font-normal text-muted-foreground">{entry.scope === 'workspace' ? entry.workspaceName || t('workspace') : t('personal')}</span></summary>
                  <div className="grid gap-3 border-t p-3">
                    <p className="break-all text-xs text-muted-foreground">{t('sendingFrom')}: {entry.senderAddress || t('unknownSender')}</p>
                    {(['toText', 'ccText', 'bccText'] as const).map((field) => {
                      const name = field.replace('Text', '') as 'to' | 'cc' | 'bcc';
                      return <div key={field} className="grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-2"><Label htmlFor={`email-review-${name}`}>{t(name)}</Label><Input id={`email-review-${name}`} data-testid={`email-review-${name}`} value={state.form![field]} disabled={disabled} onChange={(event) => updateEmailReviewForm({ [field]: event.target.value })} /></div>;
                    })}
                    <p className="text-xs text-muted-foreground">{t('recipientHelp')}</p>
                  </div>
                </details>
                <div><div className="mb-1 flex items-center justify-between gap-2"><Label htmlFor="email-review-body">{t('body')}</Label><Button data-testid="email-review-formatting" variant="ghost" size="sm" className="h-7 text-xs" aria-expanded={showFormatting} onClick={() => setShowFormatting(!showFormatting)}><Type className="size-3.5" />{t('formatting')}</Button></div><EmailHtmlEditor key={emailReviewKey(entry)} id="email-review-body" value={state.form.bodyHtml} toolbarVisible={showFormatting} disabled={disabled} onChange={({ html }) => updateEmailReviewForm({ bodyHtml: html })} /></div>
                {(entry.errorMessage || entry.status === 'send_uncertain') && <details className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"><summary className="cursor-pointer font-medium text-destructive">{t('errorDetails')}</summary><p className="mt-2 break-words">{entry.errorMessage}</p><p className="mt-2 text-muted-foreground">{entry.status === 'send_uncertain' ? t('uncertainHelp') : t('retainedHelp')}</p></details>}
                {!entry.canWrite && <p className="text-sm text-muted-foreground">{t('readOnly')}</p>}
                {entry.status === 'sending' && <p role="status" className="text-sm text-muted-foreground">{t('sending')}</p>}
                {Boolean(entry.attachments?.length) && <details className="rounded-md border p-3"><summary className="cursor-pointer text-xs font-medium"><Paperclip className="mr-2 inline size-3" />{t('attachments')} ({entry.attachments!.length})</summary><ul className="mt-2 flex flex-wrap gap-2">{entry.attachments!.map((attachment, index) => <li key={attachment.id || index} className="max-w-full truncate rounded-md bg-muted px-3 py-2 text-xs">{attachment.name || t('attachment')}</li>)}</ul><p className="mt-2 text-xs text-muted-foreground">{t('attachmentsRetained')}</p></details>}
              </div>}
            </div>
            <div className="shrink-0 border-t bg-background px-4 py-3 sm:px-6">
              <p aria-live="polite" className="mb-2 text-xs text-muted-foreground">{state.busy ? t('working') : state.dirty ? t('unsaved') : entry ? t('saved') : t('completed')}</p>
              {entry ? <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center"><Button className="min-w-0 h-auto min-h-9 whitespace-normal px-2 text-xs has-[>svg]:px-2 sm:text-sm" data-testid="email-review-reject" variant="outline" disabled={disabled} onClick={() => void rejectActiveEmailReview()}><X />{t('reject')}</Button><Button className="min-w-0 h-auto min-h-9 whitespace-normal px-2 text-xs has-[>svg]:px-2 sm:order-last sm:ml-auto sm:text-sm" data-testid="email-review-send" disabled={disabled} onClick={() => void sendActiveEmailReview()}>{state.busy ? <Loader2 className="animate-spin" /> : <Send />}<span className="min-w-0 break-words">{t('send')}</span></Button><Button className="h-7 text-xs sm:h-9 sm:text-sm" data-testid="email-review-postpone" variant="ghost" disabled={state.busy || state.loading} onClick={() => postponeActiveEmailReview()}>{t('postpone')}</Button><Button className="h-7 text-xs sm:h-9 sm:text-sm" data-testid="email-review-save" variant="ghost" disabled={disabled || !state.dirty} onClick={() => void saveActiveEmailReview()}>{t('save')}</Button></div> : <Button onClick={() => closeEmailReview()}>{t('close')}</Button>}

            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
    <AlertDialog open={Boolean(state.pendingNavigation)} onOpenChange={(open) => { if (!open) cancelEmailReviewNavigation(); }}>
      <AlertDialogContent data-testid="email-review-unsaved-dialog"><AlertDialogHeader><AlertDialogTitle>{t('unsavedTitle')}</AlertDialogTitle><AlertDialogDescription>{t('unsavedDescription')}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><Button variant="outline" onClick={() => cancelEmailReviewNavigation()}>{t('keepEditing')}</Button><Button variant="destructive" onClick={() => void confirmDiscardEmailReviewNavigation()}>{t('discardChanges')}</Button></AlertDialogFooter></AlertDialogContent>
    </AlertDialog>
  </>;
}
