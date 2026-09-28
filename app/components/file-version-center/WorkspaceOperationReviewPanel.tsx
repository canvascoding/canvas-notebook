'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, ClipboardCheck, Loader2, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { WorkspaceOperationReviewPublic } from '@/app/lib/files/workspace-operation-review-contract';
import {
  decideWorkspaceOperationReview,
  listWorkspaceOperationReviews,
  readWorkspaceOperationReview,
  WorkspaceOperationReviewClientError,
} from '@/app/lib/files/workspace-operation-review-client';
import { useFileStore } from '@/app/store/file-store';
import {
  closeWorkspaceOperationReview,
  openWorkspaceOperationReview,
  openWorkspaceOperationReviewList,
  type WorkspaceOperationReviewRequest,
} from '@/app/store/workspace-operation-review-store';

type ReviewData = { reviews: WorkspaceOperationReviewPublic[]; review: WorkspaceOperationReviewPublic | null };

function ReviewStatus({ review }: { review: WorkspaceOperationReviewPublic }) {
  const t = useTranslations('workspaceOperationReview');
  const attention = review.status === 'stale' || review.status === 'failed'
    || review.status === 'needs_recovery' || review.status === 'blocked';
  return <span className={attention
    ? 'rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-xs text-destructive'
    : 'rounded-full border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground'}>
    {t(`status_${review.status}`)}
  </span>;
}

function ReviewDetails({ review }: { review: WorkspaceOperationReviewPublic }) {
  const t = useTranslations('workspaceOperationReview');
  const preview = review.preview;
  const deleting = 'deletedPaths' in preview;
  const pathMappings = deleting ? preview.deletedPaths.map((entry) => ({
    sourcePath: entry.path, destinationPath: '',
  })) : preview.pathMappings;
  const linkEdits = deleting ? [] : preview.linkEdits;
  const collisions = deleting ? [] : preview.collisions;

  return <div className="space-y-5 px-4 py-4 sm:px-6" data-testid="workspace-operation-review-details">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-semibold">{t(`kind_${review.kind}`)}</span>
      <ReviewStatus review={review} />
      <span className="text-xs text-muted-foreground">{review.selections.length} {t('pathChanges').toLowerCase()}</span>
    </div>

    <dl className="grid gap-2 text-xs sm:grid-cols-2">
      <div className="min-w-0 rounded-lg border bg-muted/20 p-3">
        <dt className="text-muted-foreground">{t('planId')}</dt>
        <dd className="mt-1 break-all font-mono" data-testid="workspace-operation-plan-id">{review.planId}</dd>
      </div>
      {review.operationId ? <div className="min-w-0 rounded-lg border bg-muted/20 p-3">
        <dt className="text-muted-foreground">{t('operationId')}</dt>
        <dd className="mt-1 break-all font-mono">{review.operationId}</dd>
      </div> : null}
    </dl>

    {review.reasonCodes.length > 0 ? <section aria-label={t('reasonCodes')}>
      <h3 className="mb-2 text-sm font-semibold">{t('reasonCodes')}</h3>
      <div className="flex flex-wrap gap-1.5">{review.reasonCodes.map((code) =>
        <code key={code} className="rounded-md border bg-muted/30 px-2 py-1 text-xs">{code}</code>)}</div>
    </section> : null}

    <section aria-label={t('pathChanges')}>
      <h3 className="mb-2 text-sm font-semibold">{t('pathChanges')} ({pathMappings.length})</h3>
      <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border p-2 font-mono text-xs">
        {pathMappings.map((mapping, index) => <div key={`${mapping.sourcePath}:${index}`} className="break-all rounded bg-muted/25 px-2 py-1.5">
          {mapping.sourcePath}{mapping.destinationPath ? ` → ${mapping.destinationPath}` : ''}
        </div>)}
      </div>
    </section>

    {deleting ? <section aria-label={t('brokenLinks')}>
      <h3 className="mb-2 text-sm font-semibold">{t('brokenLinks')} ({preview.potentialBrokenLinks.length})</h3>
      {preview.potentialBrokenLinks.length > 0 ? <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-2 font-mono text-xs">
        {preview.potentialBrokenLinks.map((link, index) => <div key={`${link.sourcePath}:${index}`} className="break-all px-2 py-1">
          {link.sourcePath}: {link.targetLiteral} → {link.targetPath}
        </div>)}
      </div> : <p className="text-sm text-muted-foreground">{t('noLinkChanges')}</p>}
    </section> : <section aria-label={t('linkChanges')}>
      <h3 className="mb-2 text-sm font-semibold">{t('linkChanges')} ({linkEdits.length})</h3>
      {linkEdits.length > 0 ? <div className="max-h-80 space-y-2 overflow-y-auto rounded-lg border p-2 font-mono text-xs">
        {linkEdits.map((edit, index) => <div key={`${edit.sourcePathBefore}:${edit.targetRange.startUtf16}:${index}`} className="overflow-hidden rounded border">
          <p className="break-all bg-muted/35 px-2 py-1 font-semibold">{edit.sourcePathBefore}
            {edit.sourcePathAfter !== edit.sourcePathBefore ? ` → ${edit.sourcePathAfter}` : ''}</p>
          <p className="break-all bg-destructive/[0.07] px-2 py-1 text-destructive">− {edit.previousTargetLiteral}</p>
          <p className="break-all bg-emerald-500/[0.08] px-2 py-1 text-emerald-800 dark:text-emerald-200">+ {edit.nextTargetLiteral}</p>
        </div>)}
      </div> : <p className="text-sm text-muted-foreground">{t('noLinkChanges')}</p>}
    </section>}

    <section aria-label={t('coverage')} className="space-y-2">
      <h3 className="text-sm font-semibold">{t('coverage')}: {t(preview.coverage.complete ? 'coverageComplete' : 'coverageIncomplete')}</h3>
      <p className="text-xs text-muted-foreground">{t('omittedSources')}: {preview.coverage.omittedSources.length} · {t('unresolvedLinks')}: {preview.coverage.unresolvedLinks.length}</p>
      {preview.coverage.omittedSources.length > 0 ? <ul className="space-y-1 rounded-lg border p-3 font-mono text-xs">
        {preview.coverage.omittedSources.map((item, index) => <li key={`${item.path}:${index}`} className="break-all">{item.path}: {item.reason}</li>)}
      </ul> : null}
      {preview.coverage.unresolvedLinks.length > 0 ? <ul className="max-h-40 space-y-1 overflow-y-auto rounded-lg border p-3 font-mono text-xs">
        {preview.coverage.unresolvedLinks.map((item, index) => <li key={`${item.sourcePath}:${index}`} className="break-all">
          {item.sourcePath}: {item.targetLiteral} ({item.status})
        </li>)}
      </ul> : null}
    </section>

    {collisions.length > 0 ? <section aria-label={t('collisions')}>
      <h3 className="mb-2 text-sm font-semibold">{t('collisions')} ({collisions.length})</h3>
      <ul className="rounded-lg border p-3 font-mono text-xs">{collisions.map((collision, index) =>
        <li key={`${collision.path}:${index}`} className="break-all">{collision.path}</li>)}</ul>
    </section> : null}

    {preview.issues.length > 0 ? <section aria-label={t('issues')}>
      <h3 className="mb-2 text-sm font-semibold">{t('issues')} ({preview.issues.length})</h3>
      <ul className="space-y-1 rounded-lg border border-amber-500/35 bg-amber-500/[0.05] p-3 text-xs">
        {preview.issues.map((issue, index) => <li key={`${issue.code}:${issue.path}:${index}`} className="break-words">
          <code>{issue.code}</code>{issue.path ? ` · ${issue.path}` : ''}: {issue.detail}
        </li>)}
      </ul>
    </section> : null}

    <section aria-label={t('recovery')} className="rounded-lg border bg-muted/25 p-3 text-sm">
      <h3 className="font-semibold">{t('recovery')}</h3>
      <p className="mt-1 text-muted-foreground">{deleting ? t('deleteRecovery')
        : preview.recoveryReady ? t('recoveryReady') : t('recoveryOnApply')}</p>
      {review.trashEntryIds.length > 0 ? <p className="mt-1 break-all font-mono text-xs">
        {t('trashEntries')}: {review.trashEntryIds.join(', ')}
      </p> : null}
    </section>

    {review.status === 'stale' ? <p role="alert" className="rounded-lg border border-amber-500/35 bg-amber-500/10 p-3 text-sm">{t('stale')}</p> : null}
    {review.status === 'pending' && preview.readiness === 'blocked' ? <p role="alert"
      className="rounded-lg border border-destructive/35 bg-destructive/10 p-3 text-sm">{t('blocked')}</p> : null}
    {review.status === 'blocked' ? <p role="alert" className="rounded-lg border border-destructive/35 bg-destructive/10 p-3 text-sm">{t('blocked')}</p> : null}
    {review.status === 'failed' ? <p role="alert" className="rounded-lg border border-destructive/35 bg-destructive/10 p-3 text-sm">{t('failed')} {review.errorCode}</p> : null}
    {review.status === 'needs_recovery' ? <p role="alert" className="rounded-lg border border-destructive/35 bg-destructive/10 p-3 text-sm">{t('needsRecovery')} {review.errorCode}</p> : null}
  </div>;
}

export function WorkspaceOperationReviewPanel({ request }: { request: WorkspaceOperationReviewRequest }) {
  const t = useTranslations('workspaceOperationReview');
  const [data, setData] = useState<ReviewData>({ reviews: [], review: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [action, setAction] = useState<'accept' | 'reject' | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const promise = request.mode === 'list'
      ? listWorkspaceOperationReviews(request.workspaceId, controller.signal)
        .then((reviews) => ({ reviews, review: null }))
      : readWorkspaceOperationReview(request.reviewId, request.workspaceId, controller.signal)
        .then((review) => ({ reviews: [], review }));
    void promise.then((result) => {
      if (!controller.signal.aborted) setData(result);
    }).catch((loadError) => {
      if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : t('requestFailed'));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [request, reload, t]);

  const retry = () => {
    setLoading(true);
    setError(null);
    setData({ reviews: [], review: null });
    setReload((value) => value + 1);
  };

  const decide = async (decision: 'accept' | 'reject') => {
    const review = data.review;
    if (!review || action
      || (decision === 'accept' && (review.status !== 'pending' || review.preview.readiness !== 'ready'))
      || (decision === 'reject' && !['pending', 'blocked', 'stale'].includes(review.status))) return;
    setAction(decision);
    setError(null);
    try {
      const updated = await decideWorkspaceOperationReview({
        reviewId: review.reviewId, workspaceId: request.workspaceId, planId: review.planId, action: decision,
      });
      setData({ reviews: [], review: updated });
      if (updated.status === 'applied') void useFileStore.getState().refreshVisibleTree();
    } catch (decisionError) {
      const stale = decisionError instanceof WorkspaceOperationReviewClientError
        && decisionError.code === 'PREVIEW_STALE';
      setError(stale ? t('stale') : decisionError instanceof Error ? decisionError.message : t('actionFailed'));
      if (stale) retry();
    } finally {
      setAction(null);
    }
  };

  const review = data.review;
  const canReject = review && ['pending', 'blocked', 'stale'].includes(review.status);
  const canAccept = review?.status === 'pending' && review.preview.readiness === 'ready';
  return <DialogContent layout="viewport" data-testid="workspace-operation-review-center" aria-busy={loading || action !== null}>
    <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12 sm:px-6 sm:py-4 sm:pr-14">
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/45 text-muted-foreground"><ClipboardCheck className="size-4" aria-hidden="true" /></span>
        <div className="min-w-0">
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{request.mode === 'list' ? t('listDescription') : t('detailDescription')}</DialogDescription>
        </div>
      </div>
    </DialogHeader>
    <div className="min-h-0 flex-1 overflow-y-auto">
      {loading ? <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />{t('loading')}</p> : null}
      {error ? <div className="m-4 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alert">
        <span className="min-w-0 flex-1">{error}</span>
        <Button variant="outline" size="sm" onClick={retry}><RefreshCw className="size-4" />{t('retry')}</Button>
      </div> : null}
      {!loading && request.mode === 'list' ? <div className="space-y-2 p-4 sm:p-6">
        {data.reviews.length === 0 && !error ? <p className="text-sm text-muted-foreground">{t('empty')}</p> : null}
        {data.reviews.map((item) => <button key={item.reviewId} type="button"
          className="flex w-full min-w-0 items-start gap-3 rounded-lg border p-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => openWorkspaceOperationReview(item.reviewId, request.workspaceId)}>
          <ClipboardCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1 space-y-1">
            <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">{t(`kind_${item.kind}`)} <ReviewStatus review={item} /></span>
            <span className="block break-all font-mono text-xs text-muted-foreground">
              {item.selections.map((selection) => selection.sourcePath).join(', ')}
            </span>
          </span>
        </button>)}
      </div> : null}
      {!loading && review ? <ReviewDetails review={review} /> : null}
    </div>
    <DialogFooter className="shrink-0 border-t px-4 py-3 sm:px-6">
      {request.mode === 'detail' ? <Button variant="ghost" onClick={() => openWorkspaceOperationReviewList(request.workspaceId)}>
        <ArrowLeft className="size-4" />{t('back')}
      </Button> : null}
      {request.mode === 'list' ? <Button variant="ghost" onClick={retry} disabled={loading}>
        <RefreshCw className="size-4" />{t('retry')}
      </Button> : null}
      <Button variant="outline" onClick={closeWorkspaceOperationReview}>{t('close')}</Button>
      {canReject ? <Button variant="outline" onClick={() => void decide('reject')} disabled={action !== null}>
        {action === 'reject' ? <Loader2 className="size-4 animate-spin" /> : null}
        {review.status === 'pending' ? t('reject') : t('dismiss')}
      </Button> : null}
      {canAccept ? <Button onClick={() => void decide('accept')} disabled={action !== null}>
        {action === 'accept' ? <Loader2 className="size-4 animate-spin" /> : null}{t('accept')}
      </Button> : null}
    </DialogFooter>
  </DialogContent>;
}
