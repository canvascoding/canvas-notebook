'use client';

import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { EmailClassificationFeed, EmailClassificationFeedItem, EmailFeedView } from '@/app/lib/email/classification/feed-types';
import { EMAIL_CATEGORY_IDS, type EmailCategory } from '@/app/lib/email/classification/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { cn } from '@/lib/utils';
import type { EmailFocusFeedError } from './useEmailFocusFeed';

export interface EmailFocusNavigationProps {
  feed: EmailClassificationFeed | null; view: EmailFeedView; category?: EmailCategory | null;
  onViewChange(view: EmailFeedView): void; onCategoryChange(category: EmailCategory | null): void;
  onOpen(item: EmailClassificationFeedItem, dialog?: boolean): void; onDone?(item: EmailClassificationFeedItem, done: boolean): void;
  selectionKey: string | null; loading: boolean; loadingMore?: boolean; error: EmailFocusFeedError | null;
  hasUpdates: boolean; hasMore: boolean; onReload(): void; onLoadMore(): void; aggregate: boolean;
}

function reasonKeys(item: EmailClassificationFeedItem): string[] {
  const classification = item.classification;
  if (!classification) return [];
  if (classification.personallyDone) return ['done'];
  if (classification.status === 'failed' || classification.status === 'stale' || classification.status === 'pending' || classification.status === 'not_selected') return [classification.status];
  if (classification.group === 'review' || classification.status === 'uncertain') return ['uncertain'];
  const reasons: string[] = [];
  if (classification.priority === 'high' || classification.priority === 'urgent') reasons.push('highPriority');
  if (classification.needsReply === true && classification.replyStatus !== 'answered') reasons.push('needsReply');
  if (classification.isSpam === true) reasons.push('spam');
  if (!reasons.length && classification.replyStatus === 'answered') reasons.push('answered');
  return reasons.slice(0, 2);
}

export function EmailFocusNavigation({ feed, view, category, onViewChange, onCategoryChange, onOpen, onDone,
  selectionKey, loading, loadingMore = false, error, hasUpdates, hasMore, onReload, onLoadMore, aggregate }: EmailFocusNavigationProps) {
  const t = useTranslations('emailFocus');
  const locale = useLocale();
  const categorized = feed?.mode !== 'classic';
  const counts = feed?.counts;
  const incomplete = Boolean(feed?.coverage.some(source => source.state !== 'complete' || source.pending || source.failed || source.stale));
  const sourceFailed = Boolean(feed?.coverage.some(source => source.state === 'failed'));
  const rows = feed?.items ?? [];
  const sections = categorized && view === 'focus'
    ? (['important', 'reply'] as const).map(group => ({ id: group, title: t(`views.${group}`), items: rows.filter(item => item.classification?.group === group) }))
    : [{ id: view, title: category ? t(`categories.${category}`) : t(`views.${view}`), items: rows }];
  const visibleRows = sections.reduce((total, section) => total + section.items.length, 0);
  const chooseView = (next: EmailFeedView) => { onCategoryChange(null); onViewChange(next); };
  const count = (next: EmailFeedView) => next === 'all' ? counts?.total ?? 0 : next === 'focus'
    ? (counts?.groups.important ?? 0) + (counts?.groups.reply ?? 0) : counts?.groups[next] ?? 0;
  const viewButton = (next: EmailFeedView, prominent = false) => (
    <Button key={next} type="button" variant={view === next && !category ? 'secondary' : 'ghost'} size="sm"
      className={cn('min-w-0 justify-between gap-2', prominent && 'h-auto min-h-11 flex-1 border px-3 py-2')}
      aria-label={`${t(`views.${next}`)}: ${count(next)}`} aria-pressed={view === next && !category} onClick={() => chooseView(next)}>
      <span className={prominent ? 'min-w-0 whitespace-normal text-left leading-snug' : 'truncate'}>{t(`views.${next}`)}</span><span className="shrink-0 tabular-nums text-muted-foreground">{count(next)}</span>
    </Button>
  );
  const date = (value: string) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(timestamp) : '—';
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="email-focus-navigation">
      <div className="space-y-3 border-b px-3 py-3 sm:px-4">
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('viewLabel')}>
          {categorized && viewButton('focus')}{viewButton('all')}
        </div>
        {categorized && <>
          <div className="flex gap-2" aria-label={t('unresolvedLabel')}>
            {viewButton('review', true)}{viewButton('pending', true)}
          </div>
          <details className="group text-sm">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-md py-1.5 text-xs font-medium text-muted-foreground focus-visible:outline-ring">
              {category ? t('categoryFilter', { category: t(`categories.${category}`) }) : t('moreViews')}<ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div className="mt-2 space-y-2">
              <div className="flex flex-wrap gap-1">{viewButton('important')}{viewButton('reply')}{viewButton('other')}{viewButton('spam')}{viewButton('done')}</div>
              <div className="grid grid-cols-2 gap-1" role="group" aria-label={t('categoryLabel')}>
                {EMAIL_CATEGORY_IDS.map(id => <Button key={id} type="button" variant={category === id ? 'secondary' : 'ghost'} size="sm" className="min-w-0 justify-between gap-2"
                  aria-label={`${t(`categories.${id}`)}: ${counts?.categories[id] ?? 0}`} aria-pressed={category === id} onClick={() => { onViewChange('all'); onCategoryChange(id); }}><span className="truncate">{t(`categories.${id}`)}</span><span className="tabular-nums text-muted-foreground">{counts?.categories[id] ?? 0}</span></Button>)}
              </div>
            </div>
          </details>
        </>}
        {hasUpdates && !error && <InlineNotice size="compact" actions={<Button type="button" size="sm" variant="outline" onClick={onReload} disabled={loading}>{t('applyUpdates')}</Button>}>{t('updatesAvailable')}</InlineNotice>}
        {error && <InlineNotice variant="warning" size="compact" actions={<Button type="button" size="sm" variant="outline" onClick={onReload} disabled={loading}>{t('refresh')}</Button>}>
          {t(error.status === 401 || error.status === 403 ? 'feedErrors.access' : error.status === 409 ? 'feedErrors.changed' : error.status === 404 ? 'feedErrors.source' : 'feedErrors.unavailable')}
        </InlineNotice>}
        {!error && incomplete && <p className={cn('text-xs leading-relaxed', sourceFailed ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')} role="status">
          {t(sourceFailed ? 'coverageFailed' : 'coveragePartial')}
        </p>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && !feed ? <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" />{t('loading')}</div>
          : !visibleRows && !error ? <div className="space-y-2 px-5 py-10 text-center"><p className="text-sm font-medium">{t(incomplete ? 'emptyPreparing' : view === 'focus' ? 'emptyFocus' : 'emptyView')}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{t(view === 'focus' ? 'emptyFocusHint' : 'emptyViewHint')}</p>
            {view !== 'all' && <Button type="button" variant="outline" size="sm" onClick={() => chooseView('all')}>{t('views.all')}</Button>}
          </div> : sections.map(section => section.items.length > 0 && <section key={section.id} aria-label={section.title}>
            <h2 className="sticky top-0 z-10 border-b bg-background/95 px-4 py-2 text-xs font-semibold backdrop-blur">{section.title}</h2>
            <ul>{section.items.map(item => {
              const selected = item.selectionKey === selectionKey;
              const reasons = reasonKeys(item);
              const sourceLabel = `${t(item.origin.workspaceId ? 'sources.work' : 'sources.personal')} · ${item.origin.workspaceName ? `${item.origin.workspaceName} · ` : ''}${item.origin.emailAddress}`;
              return <li key={item.selectionKey} className={cn('group flex items-start border-b transition-colors hover:bg-muted/40', selected && 'bg-muted/60') }>
                <button type="button" onClick={() => onOpen(item)} aria-current={selected ? 'true' : undefined} className="min-w-0 flex-1 space-y-1.5 px-4 py-3 text-left focus-visible:outline-ring" data-testid="email-focus-row">
                  <div className="flex items-center justify-between gap-3"><span className={cn('truncate text-sm', !item.message.isRead && 'font-semibold')}>{item.message.from || t('unknownSender')}</span><time className="shrink-0 text-[11px] text-muted-foreground" dateTime={item.message.date}>{date(item.message.date)}</time></div>
                  <p className={cn('truncate text-sm', !item.message.isRead && 'font-medium')}>{item.message.subject || t('noSubject')}</p>
                  {item.message.snippet && <p className="line-clamp-1 text-xs leading-relaxed text-muted-foreground">{item.message.snippet}</p>}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    {aggregate && <Badge variant="outline" title={sourceLabel} className="max-w-full rounded-sm px-1.5 py-0 text-[10px] font-normal"><span className="truncate">{sourceLabel}</span></Badge>}
                    {reasons.map(reason => <span key={reason}>{t(`reasons.${reason}`)}</span>)}
                  </div>
                </button>
                {onDone && item.origin.capabilities.canRead && <Button type="button" variant="ghost" size="icon" className="mr-1 mt-2 shrink-0 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                  aria-label={t(item.personalFocus.done ? 'undoItem' : 'doneItem', { subject: item.message.subject || t('noSubject') })}
                  title={t('donePersonalHint')} onClick={() => onDone(item, !item.personalFocus.done)}><Check className="h-4 w-4" /></Button>}
              </li>;
            })}</ul>
          </section>)}
        {hasMore && !error && <div className="p-3"><Button type="button" variant="outline" className="w-full" disabled={loadingMore || loading} onClick={onLoadMore}>{loadingMore && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{t('loadMore')}</Button></div>}
      </div>
      {feed && <p className="border-t px-4 py-2 text-[10px] leading-relaxed text-muted-foreground">{t('indexScopeHint', { days: feed.limits.initialLookbackDays, maximum: feed.limits.maxHistoricalMessages })}</p>}
    </div>
  );
}
