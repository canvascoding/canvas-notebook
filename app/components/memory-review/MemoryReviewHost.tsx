'use client';

import { Check, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MemoryMarkdownContent } from '@/app/components/settings/MemoryMarkdownContent';
import { memoryCategoryLabel } from '@/app/lib/memory/categories';
import { Link } from '@/i18n/navigation';
import { approveActiveMemory, closeMemoryReview, rejectActiveMemory, retryActiveMemory, useMemoryReviewStore } from '@/app/store/memory-review-store';

export function MemoryReviewHost() {
  const t = useTranslations('memoryReview'); const locale = useLocale();
  const state = useMemoryReviewStore();
  const entry = state.activeEntry;
  const settingsParams = new URLSearchParams({ tab: 'memory', status: 'pending' });
  if (entry) {
    settingsParams.set('scope', entry.target.scope);
    settingsParams.set('collectionId', entry.target.collectionId);
    settingsParams.set('entryId', entry.target.entryId);
    if (entry.target.workspaceId) settingsParams.set('workspaceId', entry.target.workspaceId);
  }
  const settingsHref = `/settings?${settingsParams.toString()}`;
  const submittedAt = entry ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(entry.submittedAt) : null;
  return <Dialog open={state.open} onOpenChange={(open) => { if (!open) closeMemoryReview(); }}>
    <DialogContent className="flex max-h-[min(86dvh,48rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl" aria-describedby="memory-review-description">
      <DialogHeader className="border-b px-5 py-4 pr-12 text-left"><DialogTitle>{t('title')}</DialogTitle><DialogDescription id="memory-review-description">{state.completed ? t('completed') : state.queue.length ? t('progress', { current: state.activeIndex + 1, total: state.queue.length }) : t('loading')}</DialogDescription></DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {state.loading && <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="mr-2 size-5 animate-spin" />{t('loading')}</div>}
        {state.completed && <div className="py-16 text-center"><Check className="mx-auto mb-3 size-10 rounded-full bg-primary/10 p-2 text-primary" /><p className="font-medium">{t('completed')}</p></div>}
        {entry && !state.loading && <><div className="mb-4 flex flex-wrap gap-2 text-xs text-muted-foreground"><span className="rounded-full bg-muted px-2.5 py-1">{memoryCategoryLabel(entry.category, locale === 'de' ? 'de' : 'en')}</span><span className="rounded-full bg-muted px-2.5 py-1">{t(`scope.${entry.target.scope}`)}</span>{entry.workspaceName && <span>{entry.workspaceName}</span>}</div><MemoryMarkdownContent content={entry.content} /><div className="mt-6 space-y-1 text-xs text-muted-foreground"><p>{t('submittedBy', { name: entry.submittedBy || t('unknown') })}</p>{submittedAt && <p>{t('submittedAt', { date: submittedAt })}</p>}</div></>}
        {state.error && <div role="alert" className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"><p>{state.error}</p>{!entry && <Button variant="ghost" size="sm" className="mt-2 text-destructive" onClick={() => void retryActiveMemory()}><RefreshCw />{t('retry')}</Button>}</div>}
      </div>
      <DialogFooter className="flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between"><Button asChild variant="link" className="self-start px-0 text-muted-foreground"><Link href={settingsHref} onClick={closeMemoryReview}><ExternalLink className="size-4" />{t('openSettings')}</Link></Button>{state.completed ? <Button onClick={closeMemoryReview}>{t('close')}</Button> : <div className="flex w-full gap-2 sm:w-auto"><Button variant="outline" onClick={() => void rejectActiveMemory()} disabled={!entry || Boolean(state.deciding) || state.loading} className="flex-1 sm:flex-none">{state.deciding === 'reject' ? <Loader2 className="animate-spin" /> : <X />}{t('reject')}</Button><Button onClick={() => void approveActiveMemory()} disabled={!entry || Boolean(state.deciding) || state.loading} className="flex-1 sm:flex-none">{state.deciding === 'approve' ? <Loader2 className="animate-spin" /> : <Check />}{t('approve')}</Button></div>}</DialogFooter>
    </DialogContent>
  </Dialog>;
}
