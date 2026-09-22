'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertCircle, ArrowLeft, Check, ExternalLink, Inbox, Loader2, Mail, Paperclip, RefreshCw, Send, X } from 'lucide-react';
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
      <DialogContent data-testid="email-review-host" onOpenAutoFocus={() => setMobileList(false)} showCloseButton={false} className="flex h-[92dvh] max-h-[58rem] min-h-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl" aria-describedby="email-review-description">
        <DialogHeader className="shrink-0 border-b px-4 py-4 text-left sm:px-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3"><Mail className="size-5 text-muted-foreground" /><DialogTitle>{t('title')}</DialogTitle></div>
            <Button variant="ghost" size="icon" aria-label={t('close')} disabled={state.busy} onClick={() => closeEmailReview()}><X /></Button>
          </div>
          <DialogDescription id="email-review-description">{t('description')}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1">
          <aside className={cn('w-full shrink-0 flex-col border-r bg-muted/25 md:flex md:w-72 lg:w-80', mobileList && entry ? 'flex' : 'hidden')}>
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
          <section className={cn('min-w-0 flex-1 flex-col', mobileList && entry ? 'hidden md:flex' : 'flex')} aria-label={t('message')}>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
              {!entry && <div className="mb-4 flex flex-wrap gap-2 md:hidden"><Button size="sm" variant="outline" disabled={state.busy || state.loading} onClick={() => setEmailReviewFilter('all')}>{t('all')} ({state.queue.length})</Button><Button size="sm" variant="outline" disabled={state.busy || state.loading} onClick={() => setEmailReviewFilter('failed')}>{t('failed')} ({failed.length})</Button><Button size="sm" variant="ghost" disabled={state.loading} onClick={() => void refreshEmailReview()}><RefreshCw className="size-4" />{t('refresh')}</Button></div>}
              {entry && <Button variant="ghost" size="sm" className="mb-4 md:hidden" onClick={() => setMobileList(true)}><ArrowLeft />{t('backToQueue')}</Button>}
              {state.loading && <div role="status" className="flex items-center justify-center gap-2 py-12 text-muted-foreground"><Loader2 className="size-5 animate-spin" />{t('loading')}</div>}
              {state.loadingWarnings.map((warning, index) => <p key={index} role="alert" className="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">{warning}</p>)}
              {state.error && <div data-testid="email-review-error" role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{state.error}</div>}
              {state.needsReload && <div role="alert" className="mb-4 rounded-lg border bg-muted/30 p-3 text-sm"><p>{t('reloadRequired')}</p><Button data-testid="email-review-reload" className="mt-2" size="sm" variant="outline" disabled={state.busy || state.loading} onClick={() => void refreshEmailReview()}><RefreshCw className="size-4" />{t('refresh')}</Button></div>}
              {!entry && !state.loading && <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center"><div className="rounded-full bg-muted p-4">{state.completed ? <Check className="size-7" /> : <Inbox className="size-7 text-muted-foreground" />}</div><h3 className="font-medium">{state.completed ? t('completed') : t('empty')}</h3><p className="max-w-sm text-sm text-muted-foreground">{t('emptyDescription')}</p></div>}
              {entry && state.form && <div className="space-y-5">
                <div className="rounded-lg border bg-muted/25 px-4 py-3"><p className="text-xs text-muted-foreground">{t('sendingFrom')}</p><p className="mt-1 break-all text-sm font-semibold">{entry.senderAddress || t('unknownSender')}</p><p className="mt-1 text-xs text-muted-foreground">{entry.scope === 'workspace' ? `${t('workspace')} · ${entry.workspaceName || entry.workspaceId}` : t('personal')}</p></div>
                {(entry.errorMessage || entry.status === 'send_uncertain') && <div data-testid="email-review-policy-error" role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm"><div className="flex items-center gap-2 font-medium text-destructive"><AlertCircle className="size-4" />{entry.status === 'send_uncertain' ? t('uncertainTitle') : entry.errorCode === 'SEND_POLICY_BLOCKED' ? t('policyTitle') : t('sendFailedTitle')}</div><p className="mt-2 break-words">{entry.errorMessage}</p><p className="mt-2 text-muted-foreground">{entry.status === 'send_uncertain' ? t('uncertainHelp') : t('retainedHelp')}</p>{entry.errorCode === 'SEND_POLICY_BLOCKED' && <Link className="mt-3 inline-flex items-center gap-1 font-medium underline underline-offset-4" href="/settings?tab=system-email" target="_blank" rel="noopener noreferrer">{t('openPolicySettings')}<ExternalLink className="size-3" /></Link>}</div>}
                {!entry.canWrite && <p className="text-sm text-muted-foreground">{t('readOnly')}</p>}
                {entry.status === 'sending' && <p role="status" className="text-sm text-muted-foreground">{t('sending')}</p>}
                <div className="grid gap-3">
                  {(['toText', 'ccText', 'bccText', 'subject'] as const).map((field) => {
                    const name = field === 'subject' ? field : field.replace('Text', '');
                    return <div key={field} className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-2"><Label htmlFor={`email-review-${name}`}>{t(name as 'to' | 'cc' | 'bcc' | 'subject')}</Label><Input id={`email-review-${name}`} data-testid={`email-review-${name}`} value={state.form![field]} disabled={disabled} onChange={(event) => updateEmailReviewForm({ [field]: event.target.value })} /></div>;
                  })}
                  <p className="pl-[4rem] text-xs text-muted-foreground">{t('recipientHelp')}</p>
                </div>
                <div><Label className="mb-2 block" htmlFor="email-review-body">{t('body')}</Label><EmailHtmlEditor key={emailReviewKey(entry)} id="email-review-body" value={state.form.bodyHtml} disabled={disabled} onChange={({ html }) => updateEmailReviewForm({ bodyHtml: html })} /></div>
                {Boolean(entry.attachments?.length) && <div><p className="mb-2 text-xs font-medium text-muted-foreground">{t('attachments')}</p><ul className="flex flex-wrap gap-2">{entry.attachments!.map((attachment, index) => <li key={attachment.id || index} className="flex max-w-full items-center gap-2 rounded-md border px-3 py-2 text-xs"><Paperclip className="size-3 shrink-0" /><span className="truncate">{attachment.name || t('attachment')}</span></li>)}</ul><p className="mt-2 text-xs text-muted-foreground">{t('attachmentsRetained')}</p></div>}
              </div>}
            </div>
            <div className="shrink-0 border-t bg-background px-4 py-3 sm:px-6">
              <p aria-live="polite" className="mb-2 text-xs text-muted-foreground">{state.busy ? t('working') : state.dirty ? t('unsaved') : entry ? t('saved') : t('completed')}</p>
              {entry ? <div className="flex flex-wrap items-center gap-2"><Button data-testid="email-review-reject" variant="outline" disabled={disabled} onClick={() => void rejectActiveEmailReview()}><X />{t('reject')}</Button><Button data-testid="email-review-postpone" variant="ghost" disabled={state.busy || state.loading} onClick={() => postponeActiveEmailReview()}>{t('postpone')}</Button><div className="ml-auto flex flex-wrap gap-2"><Button data-testid="email-review-save" variant="outline" disabled={disabled || !state.dirty} onClick={() => void saveActiveEmailReview()}>{t('save')}</Button><Button data-testid="email-review-send" disabled={disabled} onClick={() => void sendActiveEmailReview()}>{state.busy ? <Loader2 className="animate-spin" /> : <Send />}{t('send')}</Button></div></div> : <Button onClick={() => closeEmailReview()}>{t('close')}</Button>}
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
