'use client';

import { Check, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MemoryMarkdownContent } from '@/app/components/settings/MemoryMarkdownContent';
import { WorkspaceIdentityMark } from '@/app/components/workspaces/WorkspaceIdentityMark';
import { memoryCategoryLabel } from '@/app/lib/memory/categories';
import { Link } from '@/i18n/navigation';
import { approveActiveMemory, closeMemoryReview, rejectActiveMemory, retryActiveMemory, useMemoryReviewStore } from '@/app/store/memory-review-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';

export function MemoryReviewHost() {
  const t = useTranslations('memoryReview');
  const locale = useLocale();
  const state = useMemoryReviewStore();
  const entry = state.activeEntry;
  const workspace = useWorkspaceStore((workspaceState) => workspaceState.workspaces.find((candidate) => candidate.id === entry?.target.workspaceId) ?? null);
  const workspaceLabel = entry?.workspaceName || workspace?.name || null;
  const totalCount = state.totalCount || state.queue.length;
  const reviewedCount = Math.max(0, totalCount - state.queue.length);
  const current = Math.min(totalCount, reviewedCount + 1);
  const settingsParams = new URLSearchParams({ tab: 'memory', status: 'pending' });
  if (entry) {
    settingsParams.set('scope', entry.target.scope);
    settingsParams.set('collectionId', entry.target.collectionId);
    settingsParams.set('entryId', entry.target.entryId);
    if (entry.target.workspaceId) settingsParams.set('workspaceId', entry.target.workspaceId);
  }
  const settingsHref = `/settings?${settingsParams.toString()}`;
  const submittedAt = entry ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(entry.submittedAt) : null;

  return (
    <Dialog open={state.open} onOpenChange={(open) => { if (!open) closeMemoryReview(); }}>
      <DialogContent className="flex max-h-[min(86dvh,48rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl" aria-describedby="memory-review-description">
        <DialogHeader className="border-b px-5 py-4 pr-12 text-left sm:px-6 sm:pr-12">
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription id="memory-review-description">
            {state.completed
              ? t('completed')
              : state.queue.length
                ? t('progress', { current, total: totalCount })
                : t('loading')}
          </DialogDescription>
          {totalCount > 1 && !state.completed && (
            <div
              role="progressbar"
              aria-label={t('progressLabel')}
              aria-valuemin={0}
              aria-valuemax={totalCount}
              aria-valuenow={reviewedCount}
              className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
                style={{ width: `${(reviewedCount / totalCount) * 100}%` }}
              />
            </div>
          )}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          {state.loading && (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="mr-2 size-5 animate-spin" />
              {t('loading')}
            </div>
          )}
          {state.completed && (
            <div className="py-16 text-center">
              <Check className="mx-auto mb-3 size-10 rounded-full bg-primary/10 p-2 text-primary" />
              <p className="font-medium">{t('completed')}</p>
            </div>
          )}
          {entry && !state.loading && (
            <>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  {workspace && <WorkspaceIdentityMark workspace={workspace} className="size-8 rounded-lg" iconClassName="size-4" />}
                  <div className="min-w-0">
                    {workspaceLabel && <p className="text-[11px] font-medium text-muted-foreground">{t(`scope.${entry.target.scope}`)}</p>}
                    <p className="truncate text-sm font-semibold text-foreground">{workspaceLabel || t(`scope.${entry.target.scope}`)}</p>
                  </div>
                </div>
                <span className="rounded-full border border-border/70 bg-muted/50 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                  {memoryCategoryLabel(entry.category, locale === 'de' ? 'de' : 'en')}
                </span>
              </div>
              <div className="rounded-lg border border-border/70 bg-muted/20 px-4 py-4 sm:px-5 sm:py-5">
                <MemoryMarkdownContent content={entry.content} className="max-w-[65ch] text-[15px] leading-7 [&_p+p]:mt-3" />
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>{t('submittedBy', { name: entry.submittedBy || t('unknown') })}</span>
                {submittedAt && (
                  <>
                    <span aria-hidden="true">·</span>
                    <time dateTime={new Date(entry.submittedAt).toISOString()} aria-label={t('submittedAt', { date: submittedAt })}>
                      {submittedAt}
                    </time>
                  </>
                )}
              </div>
            </>
          )}
          {state.error && (
            <div role="alert" className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <p>{state.error}</p>
              {!entry && <Button variant="ghost" size="sm" className="mt-2 text-destructive" onClick={() => void retryActiveMemory()}><RefreshCw />{t('retry')}</Button>}
            </div>
          )}
        </div>

        <DialogFooter className="flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <Button asChild variant="link" className="self-start px-0 text-muted-foreground">
            <Link href={settingsHref} onClick={closeMemoryReview}><ExternalLink className="size-4" />{t('openSettings')}</Link>
          </Button>
          {state.completed ? (
            <Button onClick={closeMemoryReview}>{t('close')}</Button>
          ) : (
            <div className="flex w-full gap-2 sm:w-auto">
              <Button variant="outline" onClick={() => void rejectActiveMemory()} disabled={!entry || Boolean(state.deciding) || state.loading} className="flex-1 sm:flex-none">
                {state.deciding === 'reject' ? <Loader2 className="animate-spin" /> : <X />}
                {t('reject')}
              </Button>
              <Button onClick={() => void approveActiveMemory()} disabled={!entry || Boolean(state.deciding) || state.loading} className="flex-1 sm:flex-none">
                {state.deciding === 'approve' ? <Loader2 className="animate-spin" /> : <Check />}
                {t('approve')}
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
