'use client';

import { Check, ExternalLink, Loader2, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MemoryMarkdownContent } from '@/app/components/settings/MemoryMarkdownContent';
import { approveActiveMemory, closeMemoryReview, rejectActiveMemory, useMemoryReviewStore } from '@/app/store/memory-review-store';

export function MemoryReviewHost() {
  const t = useTranslations('memoryReview'); const locale = useLocale();
  const state = useMemoryReviewStore();
  const entry = state.activeEntry;
  const settingsHref = entry ? `/${locale}/settings?tab=memory&scope=${entry.target.scope}&collectionId=${encodeURIComponent(entry.target.collectionId)}` : '#';
  return <Dialog open={state.open} onOpenChange={(open) => { if (!open) closeMemoryReview(); }}>
    <DialogContent className="flex max-h-[min(86dvh,48rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl" aria-describedby="memory-review-description">
      <DialogHeader className="border-b px-5 py-4 pr-12 text-left"><DialogTitle>{t('title')}</DialogTitle><DialogDescription id="memory-review-description">{state.completed ? t('completed') : state.queue.length ? t('progress', { current: state.activeIndex + 1, total: state.queue.length }) : t('loading')}</DialogDescription></DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        {state.loading && <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="mr-2 size-5 animate-spin" />{t('loading')}</div>}
        {state.completed && <div className="py-16 text-center"><Check className="mx-auto mb-3 size-10 rounded-full bg-primary/10 p-2 text-primary" /><p className="font-medium">{t('completed')}</p></div>}
        {entry && !state.loading && <><div className="mb-4 flex flex-wrap gap-2 text-xs text-muted-foreground"><span className="rounded-full bg-muted px-2.5 py-1">{entry.category}</span><span className="rounded-full bg-muted px-2.5 py-1">{entry.target.scope}</span>{entry.workspaceName && <span>{entry.workspaceName}</span>}</div><MemoryMarkdownContent content={entry.content} /><div className="mt-6 text-xs text-muted-foreground">{t('submittedBy', { name: entry.submittedBy || t('unknown') })}</div></>}
        {state.error && <p role="alert" className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{state.error}</p>}
      </div>
      <DialogFooter className="flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between"><Button asChild variant="link" className="self-start px-0 text-muted-foreground"><a href={settingsHref}><ExternalLink className="size-4" />{t('openSettings')}</a></Button><div className="flex w-full gap-2 sm:w-auto"><Button variant="outline" onClick={() => void rejectActiveMemory()} disabled={!entry || state.deciding || state.loading} className="flex-1 sm:flex-none"><X />{t('reject')}</Button><Button onClick={() => void approveActiveMemory()} disabled={!entry || state.deciding || state.loading} className="flex-1 sm:flex-none">{state.deciding && <Loader2 className="animate-spin" />}<Check />{t('approve')}</Button></div></DialogFooter>
    </DialogContent>
  </Dialog>;
}
