'use client';

import {
  Bot,
  CheckCircle2,
  Clock3,
  FileClock,
  History,
  LoaderCircle,
  LockKeyhole,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import type {
  FileVersionTimelineEntryV1,
  FileVersionTimelineResponseV1,
} from '@/app/lib/file-version-center/contracts/v1';
import {
  fileVersionTimelineEntryKey,
  groupFileVersionTimeline,
  type FileVersionTimelineSelection,
} from '@/app/lib/file-version-center/timeline-state';
import type { GraphReviewCardStatus } from './GraphReviewComparison';
import type { ProposalReviewSummaryResponseV1 } from '@/app/lib/file-version-center/contracts/proposal-review-summary-v1';

type ReviewSummaryItem = ProposalReviewSummaryResponseV1['items'][number];

type FileVersionTimelineProps = {
  timeline: FileVersionTimelineResponseV1;
  selection: FileVersionTimelineSelection;
  onSelect: (entry: FileVersionTimelineEntryV1) => void;
  onLoadMore: () => void;
  loadingMore: boolean;
  loadMoreError: string | null;
  evaluatedReview?: GraphReviewCardStatus | null;
  reviewSummary?: ReviewSummaryItem[] | null;
  reviewGroupRoots?: ReadonlyMap<string, string> | null;
  reviewSummaryError?: string | null;
  onRetryReviewSummary?: () => void;
};

const CONFLICT_STATUSES = new Set(['semantic_conflict', 'partially_applied']);
const FAILED_STATUSES = new Set(['failed', 'expired']);

function entryTimestamp(entry: FileVersionTimelineEntryV1): string {
  return entry.kind === 'current' ? entry.observedAt : entry.createdAt;
}

function TimelineRow({
  entry,
  selected,
  onSelect,
  evaluatedReview,
  summaryItem,
  summaryPending,
  summaryError,
}: {
  entry: FileVersionTimelineEntryV1;
  selected: boolean;
  onSelect: () => void;
  evaluatedReview?: GraphReviewCardStatus | null;
  summaryItem?: ReviewSummaryItem;
  summaryPending?: boolean;
  summaryError?: boolean;
}) {
  const t = useTranslations('fileVersionCenter');
  const locale = useLocale();
  const proposal = summaryItem?.mode === 'graph' ? summaryItem.proposal : null;
  const evaluation = entry.kind === 'agent_operation' && evaluatedReview?.operationId === entry.operationId
    ? evaluatedReview : summaryItem?.mode === 'graph' ? summaryItem : null;
  const lifecycle = entry.kind === 'agent_operation' && evaluatedReview?.operationId === entry.operationId
    ? evaluatedReview.lifecycle ?? proposal?.lifecycle : proposal?.lifecycle;
  const historicalLifecycle = lifecycle && lifecycle !== 'open' ? lifecycle : null;
  const unverified = entry.kind === 'agent_operation' && !evaluation && !summaryItem;
  const legacyVerified = summaryItem?.mode === 'legacy';
  const conflict = entry.kind === 'agent_operation' && !historicalLifecycle && (evaluation
    ? ['conflicted', 'blocked_by_parent', 'prerequisite_lost', 'unavailable', 'stale_lifecycle'].includes(evaluation.status)
    : legacyVerified && CONFLICT_STATUSES.has(entry.status));
  const failed = entry.kind === 'agent_operation' && legacyVerified && FAILED_STATUSES.has(entry.status);
  const isAgent = entry.kind === 'agent_operation';
  const isCurrent = entry.kind === 'current';
  const metadataOnly = entry.kind === 'revision' && entry.content.availability === 'metadata_only';
  const timestamp = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(entryTimestamp(entry)));
  const status = historicalLifecycle ? t(`graph.context.lifecycle.${historicalLifecycle}`)
    : evaluation ? t(`graph.status.${evaluation.status}`)
    : unverified && (summaryError || !summaryPending) ? t('graph.summaryUnavailable')
    : unverified ? t('graph.summaryChecking')
    : metadataOnly ? t('metadataOnlyBadge') : isAgent ? t(`status.${entry.status}`) : isCurrent
    ? t('status.current')
    : t(`source.${entry.source}`);
  const title = proposal ? t(`graph.card.${proposal.relation}`) : isAgent ? t('agentProposal') : isCurrent
    ? t('currentVersion')
    : t('revisionNumber', { number: entry.revisionNumber });
  const actor = entry.kind === 'current' ? t('authoritativeState')
    : entry.actor.displayName ?? t(`actor.${entry.actor.type}`);
  const diff = isAgent && legacyVerified
    && (entry.additions !== undefined || entry.deletions !== undefined)
    ? t('changeCount', { additions: entry.additions ?? 0, deletions: entry.deletions ?? 0 })
    : null;
  const Icon = historicalLifecycle ? History : conflict ? TriangleAlert : failed ? ShieldAlert : isAgent ? Sparkles
    : isCurrent ? CheckCircle2 : History;

  return (
    <li className={proposal && !['root', 'detached'].includes(proposal.relation) ? 'border-l-2 border-violet-500/25 pl-3' : undefined}>
      <button
        type="button"
        aria-pressed={selected}
        data-entry-kind={entry.kind}
        data-entry-status={isAgent ? historicalLifecycle ?? evaluation?.status ?? (legacyVerified ? entry.status : undefined) : undefined}
        data-operation-id={isAgent ? entry.operationId : undefined}
        data-proposal-relation={proposal?.relation}
        onClick={onSelect}
        className={cn(
          'group w-full rounded-lg border px-3 py-3 text-left transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          isAgent && !historicalLifecycle && 'border-violet-500/25 bg-violet-500/[0.045] hover:bg-violet-500/[0.085]',
          historicalLifecycle && 'border-border bg-muted/25 hover:bg-muted/40',
          isCurrent && 'border-emerald-500/25 bg-emerald-500/[0.055] hover:bg-emerald-500/[0.09]',
          entry.kind === 'revision' && 'border-border bg-background hover:bg-muted/45',
          conflict && 'border-amber-500/40 bg-amber-500/[0.07] hover:bg-amber-500/[0.12]',
          failed && 'border-destructive/35 bg-destructive/[0.055] hover:bg-destructive/[0.09]',
          selected && 'ring-2 ring-inset ring-primary/65',
        )}
      >
        <span className="flex items-start gap-3">
          <span className={cn(
            'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border bg-background/80',
            isAgent && !historicalLifecycle && 'border-violet-500/25 text-violet-600 dark:text-violet-300',
            historicalLifecycle && 'border-border text-muted-foreground',
            isCurrent && 'border-emerald-500/25 text-emerald-700 dark:text-emerald-300',
            conflict && 'border-amber-500/35 text-amber-700 dark:text-amber-300',
            failed && 'border-destructive/30 text-destructive',
            entry.kind === 'revision' && 'text-muted-foreground',
          )}>
            <Icon className="size-4" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span className="truncate text-sm font-medium">{title}</span>
              <Badge
                variant="outline"
                className={cn(
                  'shrink-0 bg-background/70 font-medium',
                  isAgent && !conflict && !failed && !historicalLifecycle && 'border-violet-500/30 text-violet-700 dark:text-violet-200',
                  historicalLifecycle && 'border-border text-foreground',
                  isCurrent && 'border-emerald-500/30 text-emerald-700 dark:text-emerald-200',
                  conflict && 'border-amber-500/45 text-amber-800 dark:text-amber-200',
                  failed && 'border-destructive/40 text-destructive',
                  metadataOnly && 'border-amber-500/45 text-amber-800 dark:text-amber-200',
                )}
              >
                {status}
              </Badge>
            </span>
            <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              {entry.kind !== 'current' && entry.actor.type === 'agent'
                ? <Bot className="size-3" aria-hidden="true" />
                : entry.kind !== 'current' && entry.actor.type === 'user'
                  ? <UserRound className="size-3" aria-hidden="true" />
                  : <Clock3 className="size-3" aria-hidden="true" />}
              <span className="truncate">{actor}</span>
              <span aria-hidden="true">·</span>
              <time dateTime={entryTimestamp(entry)}>{timestamp}</time>
            </span>
            {diff ? <span className="mt-1 block text-xs font-medium text-muted-foreground">{diff}</span> : null}
            {evaluation?.reasonCode && !historicalLifecycle ? <span className="mt-1 block text-xs text-amber-800 dark:text-amber-200">
              {evaluation.reasonCode === 'PROPOSAL_BATCH_CONFLICT'
                ? t('graph.singleCurrentConflict') : t(`graph.reason.${evaluation.reasonCode}`)}
            </span> : null}
          </span>
        </span>
      </button>
    </li>
  );
}

export function FileVersionTimeline({
  timeline,
  selection,
  onSelect,
  onLoadMore,
  loadingMore,
  loadMoreError,
  evaluatedReview,
  reviewSummary,
  reviewGroupRoots,
  reviewSummaryError,
  onRetryReviewSummary,
}: FileVersionTimelineProps) {
  const t = useTranslations('fileVersionCenter');
  const groups = groupFileVersionTimeline(timeline.entries);
  const readOnly = !timeline.capabilities.restore;
  const summaryByOperation = new Map(reviewSummary?.map((item) => [item.operationId, item]));
  const reviewBranches = new Map<string, FileVersionTimelineEntryV1[]>();
  for (const entry of groups.reviews) {
    const item = entry.kind === 'agent_operation' ? summaryByOperation.get(entry.operationId) : undefined;
    const rootId = item?.mode === 'graph' && item.proposal ? item.proposal.rootProposalId
      : entry.kind === 'agent_operation' ? reviewGroupRoots?.get(entry.operationId) : null;
    const key = rootId ? `graph:${rootId}` : 'other';
    const members = reviewBranches.get(key) ?? [];
    members.push(entry);
    reviewBranches.set(key, members);
  }
  const renderReviewRow = (entry: FileVersionTimelineEntryV1) => <TimelineRow
    key={fileVersionTimelineEntryKey(entry)} entry={entry}
    selected={selection.key === fileVersionTimelineEntryKey(entry)}
    evaluatedReview={evaluatedReview}
    summaryItem={entry.kind === 'agent_operation' ? summaryByOperation.get(entry.operationId) : undefined}
    summaryPending={!reviewSummary && !reviewSummaryError}
    summaryError={Boolean(reviewSummaryError)}
    onSelect={() => onSelect(entry)} />;
  const reviewContent = <div className="space-y-3">
    {reviewSummaryError ? <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/35 p-2 text-xs">
      <span>{reviewSummaryError}</span>
      {onRetryReviewSummary ? <Button type="button" variant="outline" size="sm" onClick={onRetryReviewSummary}>{t('retry')}</Button> : null}
    </div> : null}
    {[...reviewBranches].map(([branch, entries]) => branch === 'other'
      ? <ol key={branch} className="space-y-2">{entries.map(renderReviewRow)}</ol>
      : <div key={branch} className="rounded-md border bg-background/70 p-2" data-testid="file-version-review-branch">
        <div className="mb-2 flex items-center justify-between gap-2 px-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
          <span>{t('graph.context.branch')}</span>
          <span className="font-mono normal-case tracking-normal" title={branch.slice(6)}>{branch.slice(6, 18)}</span>
        </div>
        <ol className="space-y-2">{entries.map(renderReviewRow)}</ol>
      </div>)}
  </div>;

  const section = (
    id: string,
    title: string,
    entries: FileVersionTimelineEntryV1[],
    emptyText?: string,
    className?: string,
    content?: ReactNode,
  ) => (
    <section
      aria-labelledby={id}
      data-testid={id === 'version-center-history' ? 'file-version-history-section' : undefined}
      className={cn('space-y-2', className)}
    >
      <div className="flex items-center justify-between gap-3 px-1">
        <h3 id={id} className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {title}
        </h3>
        <span className="text-xs tabular-nums text-muted-foreground">{entries.length}</span>
      </div>
      {entries.length > 0 ? content ?? (
        <ol className="space-y-2">
          {entries.map((entry) => (
            <TimelineRow
              key={fileVersionTimelineEntryKey(entry)}
              entry={entry}
              selected={selection.key === fileVersionTimelineEntryKey(entry)}
              evaluatedReview={evaluatedReview}
              onSelect={() => onSelect(entry)}
            />
          ))}
        </ol>
      ) : emptyText ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground">{emptyText}</p>
      ) : null}
    </section>
  );

  return (
    <nav aria-label={t('timelineLabel')} className="flex min-h-[18rem] flex-col bg-muted/[0.12] md:min-h-0 md:border-r">
      {readOnly ? (
        <div role="status" className="m-4 mb-0 flex gap-2 rounded-lg border bg-background/80 px-3 py-2.5 text-xs text-muted-foreground">
          <LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span><strong className="font-medium text-foreground">{t('readOnlyTitle')}</strong> {t('readOnlyDescription')}</span>
        </div>
      ) : null}
      {selection.state === 'pending' ? (
        <div role="status" className="mx-4 mt-4 flex gap-2 rounded-lg border border-violet-500/25 bg-violet-500/[0.045] px-3 py-2.5 text-xs">
          <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          <span>{t('selectionPending')}</span>
        </div>
      ) : selection.state === 'invalidated' ? (
        <div role="status" className="mx-4 mt-4 flex gap-2 rounded-lg border border-amber-500/35 bg-amber-500/[0.06] px-3 py-2.5 text-xs">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />
          <span>{t('selectionInvalidated')}</span>
        </div>
      ) : null}
      <ScrollArea className="min-h-[18rem] flex-1 md:min-h-0 [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:!w-full">
        <div className="w-full space-y-6 p-4 pb-6">
          {section('version-center-reviews', t('reviewsHeading'), groups.reviews, t('noReviews'), undefined, reviewContent)}
          {section('version-center-current', t('currentHeading'), groups.current ? [groups.current] : [], t('currentUnavailable'))}
          {section(
            'version-center-history',
            t('historyHeading'),
            groups.revisions,
            t('noHistory'),
            'border-t border-border/70 pt-5',
          )}
          {timeline.page.hasMore || loadMoreError ? (
            <div className="space-y-2 border-t pt-4">
              {loadMoreError ? <p role="alert" className="text-xs text-destructive">{loadMoreError}</p> : null}
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={onLoadMore}
                disabled={loadingMore}
              >
                {loadingMore
                  ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  : loadMoreError
                    ? <RotateCcw className="size-4" aria-hidden="true" />
                    : <FileClock className="size-4" aria-hidden="true" />}
                {loadingMore ? t('loadingMore') : loadMoreError ? t('retryLoadMore') : t('loadMore')}
              </Button>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </nav>
  );
}
