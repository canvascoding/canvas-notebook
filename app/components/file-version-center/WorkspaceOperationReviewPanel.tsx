'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ClipboardCheck, Loader2, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { WorkspaceOperationReviewPublic } from '@/app/lib/files/workspace-operation-review-contract';
import type { WorkspaceOperationBatchPublic } from '@/app/lib/files/workspace-operation-batch-public';
import {
  acceptWorkspaceOperationBatch,
  decideWorkspaceOperationReview,
  listWorkspaceOperationReviews,
  readWorkspaceOperationBatch,
  readWorkspaceOperationReview,
  refreshWorkspaceOperationReview,
  updateWorkspaceOperationBatch,
  WorkspaceOperationReviewClientError,
} from '@/app/lib/files/workspace-operation-review-client';
import {
  readWorkspaceOperationUndoAvailability,
  undoWorkspaceOperation,
  type WorkspaceOperationUndoAvailability,
} from '@/app/lib/files/workspace-operation-undo-client';
import { useFileStore } from '@/app/store/file-store';
import {
  closeWorkspaceOperationReview,
  openWorkspaceOperationReview,
  openWorkspaceOperationReviewList,
  type WorkspaceOperationReviewRequest,
} from '@/app/store/workspace-operation-review-store';
import { WorkspaceOperationBackupPanel } from './WorkspaceOperationBackupPanel';
import { WorkspaceOperationBatchDetails } from './WorkspaceOperationBatchDetails';
import { WorkspaceOperationCheckDetails } from './WorkspaceOperationCheckDetails';
import { ensureWorkspaceOperationCheck, forgetWorkspaceOperationCheck, useWorkspaceOperationCheck } from './workspaceOperationCheckController';
import { openWorkspaceOperationSourceDocument } from './workspaceOperationDocumentNavigation';

type ReviewData = { reviews: WorkspaceOperationReviewPublic[]; review: WorkspaceOperationReviewPublic | null;
  previousReview?: WorkspaceOperationReviewPublic | null };

function RefreshedReviewNotice({ review, previous }: {
  review: WorkspaceOperationReviewPublic; previous?: WorkspaceOperationReviewPublic | null;
}) {
  const t = useTranslations('workspaceOperationReview');
  const priorEdits = previous && !('deletedPaths' in previous.preview) ? previous.preview.linkEdits : [];
  const currentEdits = !('deletedPaths' in review.preview) ? review.preview.linkEdits : [];
  return <section className="mx-4 mt-4 space-y-2 rounded-lg border border-amber-500/30 p-3 text-sm" data-testid="workspace-operation-review-refreshed">
    <h3 className="font-semibold">{t('refreshedPreview')}</h3>
    <p className="text-xs text-muted-foreground">{t('refreshedPreviewHelp')}</p>
    {previous ? <ul className="space-y-1 text-xs">
      {review.selections.map((selection, index) => previous.selections[index]?.sourcePath !== selection.sourcePath
        ? <li key={selection.sourcePath} className="break-all">{t('refreshedPathChange', {
          before: previous.selections[index]?.sourcePath ?? '—', after: selection.sourcePath,
        })}</li> : null)}
      {JSON.stringify(priorEdits) !== JSON.stringify(currentEdits) ? <li>{t('refreshedLinkChange', { before: priorEdits.length, after: currentEdits.length })}</li> : null}
      {previous.preview.readiness !== review.preview.readiness ? <li>{t('refreshedReadinessChange', {
        before: t(previous.preview.readiness === 'ready' ? 'operationReady' : 'status_blocked'),
        after: t(review.preview.readiness === 'ready' ? 'operationReady' : 'status_blocked'),
      })}</li> : null}
    </ul> : null}
  </section>;
}

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

function ReviewDetails({ review, onOpenDocument }: { review: WorkspaceOperationReviewPublic; onOpenDocument?: (path: string, workspaceId: string) => void }) {
  const t = useTranslations('workspaceOperationReview');
  const preview = review.preview;
  const deleting = 'deletedPaths' in preview;
  const pathMappings = deleting ? preview.deletedPaths.map((entry) => ({
    sourcePath: entry.path, destinationPath: '', sourceKind: entry.kind,
  })) : preview.pathMappings;
  const groups = review.selections.map((selection) => ({
    root: pathMappings.find((mapping) => mapping.sourcePath === selection.sourcePath) ?? {
      sourcePath: selection.sourcePath, destinationPath: selection.destinationPath ?? '',
    },
    children: pathMappings.filter((mapping) => mapping.sourcePath.startsWith(`${selection.sourcePath}/`)),
  }));
  const linkEdits = deleting ? [] : preview.linkEdits;
  const linkGroups = new Map<string, typeof linkEdits>();
  for (const edit of linkEdits) {
    const edits = linkGroups.get(edit.sourcePathBefore) ?? [];
    edits.push(edit);
    linkGroups.set(edit.sourcePathBefore, edits);
  }
  const collisions = deleting ? [] : preview.collisions;
  const linkAssessment = deleting ? undefined : preview.linkAssessment;
  const blocked = review.status === 'blocked' || review.status === 'pending' && preview.readiness === 'blocked';

  return <div className="space-y-5 px-4 py-4 sm:px-6" data-testid="workspace-operation-review-details">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-semibold">{t(`kind_${review.kind}`)}</span>
      <ReviewStatus review={review} />
    </div>

    {review.status === 'pending' && preview.readiness === 'ready'
      ? <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.05] p-3 text-sm"
        aria-label={t('operationReadiness')} data-testid="workspace-operation-readiness">
        <h3 className="font-semibold">{t('operationReady')}</h3>
      </section> : null}

    {blocked || review.status === 'stale' ? <section className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/[0.05] p-3 text-sm"
      aria-label={t('nextSteps')} data-testid="workspace-operation-readiness">
      <h3 className="font-semibold">{t(review.status === 'stale' ? 'stale' : 'operationBlocked')}</h3>
      <p>{t('blockedNoChanges')}</p>
      <p>{t(linkAssessment?.blockers.length ? 'affectedLinkHelp'
        : preview.issues.some((issue) => issue.code === 'incomplete-index') ? 'incompleteIndexHelp' : 'blockedHelp')}</p>
    </section> : null}

    {linkAssessment?.blockers.length ? <section aria-label={t('linkBlockers')} data-testid="workspace-operation-link-blockers">
      <h3 className="mb-2 text-sm font-semibold">{t('linkBlockers')} ({linkAssessment.blockers.length})</h3>
      <ul className="max-h-64 space-y-3 overflow-y-auto rounded-lg border border-destructive/30 p-3 text-xs">
        {linkAssessment.blockers.map((item, index) => <li key={`${item.sourcePath}:${index}`} className="space-y-1">
          <p className="break-all font-mono font-semibold">{item.sourcePath}</p>
          {item.targetLiteral ? <p className="break-all font-mono">→ {item.targetLiteral}</p> : null}
          <p className="text-muted-foreground">{t(`linkBlocker_${item.reason}`)}</p>
          {onOpenDocument ? <Button size="sm" variant="outline" data-testid={`workspace-operation-blocker-open-${index}`}
            onClick={() => onOpenDocument(item.sourcePath, item.workspaceId ?? review.sourceWorkspaceId)}>{t('openDocument')}</Button> : null}
        </li>)}
      </ul>
    </section> : null}

    {linkAssessment?.restoredLinks?.length ? <section className="space-y-2 rounded-lg border border-emerald-500/35 bg-emerald-500/[0.05] p-3 text-sm"
      data-testid="workspace-operation-restored-links">
      <h3 className="font-semibold">{t('restoredLinks', { count: linkAssessment.restoredLinks.length })}</h3>
      <ul className="space-y-2 text-xs">{linkAssessment.restoredLinks.map((link, index) => <li key={`${link.sourcePath}:${index}`} className="break-all">
        <p className="font-mono">{link.sourcePathAfter ?? link.sourcePath}</p>
        <p>{link.targetLiteral} → {link.targetPath}</p>
      </li>)}</ul>
    </section> : null}

    <section aria-label={t('pathChanges')} data-testid="workspace-operation-path-groups">
      <h3 className="mb-2 text-sm font-semibold">{t('pathChanges')}</h3>
      <div className="space-y-2">
        {groups.map(({ root, children }) => <div key={root.sourcePath} className="min-w-0 rounded-lg border p-3">
          <p className="break-all font-mono text-sm">{root.sourcePath}{root.destinationPath ? ` → ${root.destinationPath}` : ''}</p>
          {children.length > 0 ? <details className="mt-2" data-testid="workspace-operation-path-children">
            <summary className="cursor-pointer text-xs text-muted-foreground">{t('containedPaths', { count: children.length })}</summary>
            <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto border-l pl-3 font-mono text-xs">
              {children.map((mapping) => <li key={mapping.sourcePath} className="break-all">
                {mapping.sourcePath}{mapping.destinationPath ? ` → ${mapping.destinationPath}` : ''}
              </li>)}
            </ul>
          </details> : null}
        </div>)}
      </div>
    </section>

    {deleting ? <section aria-label={t('brokenLinks')}>
      <h3 className="mb-2 text-sm font-semibold">{t('brokenLinks')} ({preview.potentialBrokenLinks.length})</h3>
      {preview.potentialBrokenLinks.length > 0 ? <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-3 font-mono text-xs">
        {preview.potentialBrokenLinks.map((link, index) => <div key={`${link.sourcePath}:${index}`} className="break-all">
          {link.sourcePath}: {link.targetLiteral} → {link.targetPath}
        </div>)}
      </div> : <p className="text-sm text-muted-foreground">{t('noLinkChanges')}</p>}
    </section> : <section aria-label={t('linkChanges')} data-testid="workspace-operation-link-groups">
      <h3 className="mb-2 text-sm font-semibold">{t('linkChanges')} ({linkEdits.length})</h3>
      {linkGroups.size > 0 ? <div className="space-y-3">
        {Array.from(linkGroups, ([sourcePath, edits]) => <div key={sourcePath} className="min-w-0 overflow-hidden rounded-lg border text-xs">
          <p className="break-all bg-muted/35 px-3 py-2 font-mono font-semibold">{sourcePath}
            {edits[0].sourcePathAfter !== sourcePath ? ` → ${edits[0].sourcePathAfter}` : ''}</p>
          <div className="divide-y">
            {edits.map((edit, index) => <div key={`${edit.targetRange.startUtf16}:${index}`} className="space-y-1 px-3 py-2 font-mono">
              <p className="break-all text-destructive"><span className="font-sans text-muted-foreground">{t('before')}: </span>{edit.previousTargetLiteral}</p>
              <p className="break-all text-emerald-800 dark:text-emerald-200"><span className="font-sans text-muted-foreground">{t('after')}: </span>{edit.nextTargetLiteral}</p>
            </div>)}
          </div>
        </div>)}
      </div> : <p className="text-sm text-muted-foreground">{t('noLinkChanges')}</p>}
    </section>}

    {collisions.length > 0 ? <section aria-label={t('collisions')}>
      <h3 className="mb-2 text-sm font-semibold">{t('collisions')} ({collisions.length})</h3>
      <ul className="rounded-lg border p-3 font-mono text-xs">{collisions.map((collision, index) =>
        <li key={`${collision.path}:${index}`} className="break-all">{collision.path}</li>)}</ul>
    </section> : null}

    {preview.issues.filter((issue) => issue.code !== 'incomplete-index').length > 0 ? <section aria-label={t('issues')}>
      <h3 className="mb-2 text-sm font-semibold">{t('issues')}</h3>
      <ul className="space-y-1 rounded-lg border border-amber-500/35 bg-amber-500/[0.05] p-3 text-xs">
        {preview.issues.filter((issue) => issue.code !== 'incomplete-index').map((issue, index) => <li key={`${issue.code}:${issue.path}:${index}`} className="break-words">
          {issue.path ? `${issue.path}: ` : ''}{issue.detail}
        </li>)}
      </ul>
    </section> : null}

    <details className="space-y-4 rounded-lg border p-3" data-testid="workspace-operation-technical-details">
      <summary className="cursor-pointer text-sm text-muted-foreground">{t('technicalDetails')}</summary>
      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-muted-foreground">{t('planId')}</dt>
          <dd className="mt-1 break-all font-mono" data-testid="workspace-operation-plan-id">{review.planId}</dd>
        </div>
        {review.operationId ? <div className="min-w-0">
          <dt className="text-muted-foreground">{t('operationId')}</dt>
          <dd className="mt-1 break-all font-mono">{review.operationId}</dd>
        </div> : null}
      </dl>
      {review.reasonCodes.length > 0 ? <section aria-label={t('reasonCodes')}>
        <h3 className="mb-2 text-xs font-semibold">{t('reasonCodes')}</h3>
        <div className="flex flex-wrap gap-1.5">{review.reasonCodes.map((code) =>
          <code key={code} className="rounded-md border bg-muted/30 px-2 py-1 text-xs">{code}</code>)}</div>
      </section> : null}
      {linkAssessment?.warnings.length ? <details className="rounded-lg border border-amber-500/30 p-3 text-xs"
        data-testid="workspace-operation-link-warnings">
        <summary className="cursor-pointer font-semibold">{t('linkWarnings')} ({linkAssessment.warnings.length})</summary>
        <p className="mt-2 text-muted-foreground">{t('linkWarningsHelp')}</p>
        <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto font-mono">
          {linkAssessment.warnings.map((item, index) => <li key={`${item.sourcePath}:${index}`} className="break-all">
            {item.sourcePath}: {item.targetLiteral} ({item.status})
          </li>)}
        </ul>
      </details> : null}
      <details aria-label={t('coverage')} className="space-y-2 rounded-lg border p-3" data-testid="workspace-operation-link-coverage">
        <summary className="cursor-pointer text-xs font-semibold">{t('coverage')}: {t(preview.coverage.complete ? 'coverageComplete' : 'coverageIncomplete')}</summary>
        {linkAssessment ? <p className="text-xs text-muted-foreground">{t('globalCoverageHelp')}</p> : null}
        <p className="text-xs text-muted-foreground">{t('omittedSources')}: {preview.coverage.omittedSources.length} · {t('unresolvedLinks')}: {preview.coverage.unresolvedLinks.length}</p>
        <ul className="max-h-40 space-y-1 overflow-y-auto font-mono text-xs">
          {preview.coverage.omittedSources.map((item, index) => <li key={`${item.path}:${index}`} className="break-all">{item.path}: {item.reason}</li>)}
          {preview.coverage.unresolvedLinks.map((item, index) => <li key={`${item.sourcePath}:${index}`} className="break-all">
            {item.sourcePath}: {item.targetLiteral} ({item.status})
          </li>)}
        </ul>
      </details>
      {preview.issues.length > 0 ? <ul className="space-y-1 font-mono text-xs">
        {preview.issues.map((issue, index) => <li key={`${issue.code}:${issue.path}:${index}`} className="break-all">
          {issue.code}{issue.path ? ` · ${issue.path}` : ''}: {issue.detail}
        </li>)}
      </ul> : null}
      <section aria-label={t('recovery')} className="text-xs text-muted-foreground">
        <h3 className="font-semibold">{t('recovery')}</h3>
        <p className="mt-1">{deleting ? t('deleteRecovery') : preview.recoveryReady ? t('recoveryReady') : t('recoveryOnApply')}</p>
        {review.trashEntryIds.length > 0 ? <p className="mt-1 break-all font-mono">{t('trashEntries')}: {review.trashEntryIds.join(', ')}</p> : null}
      </section>
      {blocked ? <p className="text-xs text-muted-foreground">{t('dismissHelp')}</p> : null}
    </details>

    {review.status === 'failed' ? <p role="alert" className="rounded-lg border border-destructive/35 bg-destructive/10 p-3 text-sm">{t('failed')} {review.errorCode}</p> : null}
    {review.status === 'needs_recovery' ? <p role="alert" className="rounded-lg border border-destructive/35 bg-destructive/10 p-3 text-sm">{t('needsRecovery')} {review.errorCode}</p> : null}
  </div>;
}

export function WorkspaceOperationReviewPanel({ request }: { request: WorkspaceOperationReviewRequest }) {
  const t = useTranslations('workspaceOperationReview');
  const requestMode = request.mode;
  const requestWorkspaceId = request.workspaceId;
  const requestReviewId = request.mode === 'detail' ? request.reviewId : null;
  const requestKey = JSON.stringify([requestMode, requestWorkspaceId, requestReviewId]);
  const [data, setData] = useState<ReviewData>({ reviews: [], review: null });
  const [dataScope, setDataScope] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [action, setAction] = useState<'accept' | 'reject' | null>(null);
  const [selectedReviews, setSelectedReviews] = useState<Set<string>>(new Set());
  const [batchRecord, setBatchRecord] = useState<{ key: string; value: WorkspaceOperationBatchPublic } | null>(null);
  const setBatch = useCallback((value: WorkspaceOperationBatchPublic | null) => setBatchRecord(value ? { key: requestKey, value } : null), [requestKey]);
  const [checkReviewIds, setCheckReviewIds] = useState<string[]>([]);
  const visibleCheckIds = request.mode === 'detail' ? checkReviewIds.filter((id) => id === request.reviewId) : checkReviewIds;
  const checkState = useWorkspaceOperationCheck(request.workspaceId, visibleCheckIds);
  const ownedBatch = batchRecord?.key === requestKey ? batchRecord.value : null;
  const batch = ownedBatch && !['preview', 'blocked'].includes(ownedBatch.status) ? ownedBatch
    : checkState ? checkState.batch : ownedBatch;
  const [batchAction, setBatchAction] = useState<'preview' | 'accept' | 'resume' | 'undo' | 'refresh' | null>(null);
  const [approvalConflict, setApprovalConflict] = useState<{ key: string; batchId: string } | null>(null);
  const approvalChanged = approvalConflict?.key === requestKey && approvalConflict.batchId === batch?.batchId
    && ['preview', 'blocked', 'needs_review'].includes(batch.status);
  const [refreshedFrom, setRefreshedFrom] = useState<string | null>(null);
  const [undoAvailability, setUndoAvailability] = useState<{
    operationId: string; value: WorkspaceOperationUndoAvailability;
  } | null>(null);
  const [undoAction, setUndoAction] = useState(false);
  const [undoneOperationId, setUndoneOperationId] = useState<string | null>(null);
  const [undoReload, setUndoReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const promise = requestMode === 'list'
      ? listWorkspaceOperationReviews(requestWorkspaceId, controller.signal)
        .then((reviews) => ({ reviews, review: null }))
      : readWorkspaceOperationReview(requestReviewId!, requestWorkspaceId, controller.signal)
        .then((review) => ({ reviews: [], review }));
    void promise.then((result) => {
      if (!controller.signal.aborted) {
        setData(result);
        setDataScope(JSON.stringify([requestMode, requestWorkspaceId, requestReviewId]));
        setSelectedReviews(new Set());
        setBatch(null);
        setRefreshedFrom(null);
        setCheckReviewIds([]);
        setLoading(false);
        if (result.review?.previousReviewId) {
          void readWorkspaceOperationReview(result.review.previousReviewId, requestWorkspaceId, controller.signal).then((previous) => {
            if (!controller.signal.aborted) setData({ ...result, previousReview: previous });
          }).catch(() => undefined);
        }
        if (result.review?.batchId) {
          void readWorkspaceOperationBatch(result.review.batchId, requestWorkspaceId, controller.signal).then((value) => {
            if (!controller.signal.aborted) setBatchRecord({ key: JSON.stringify([requestMode, requestWorkspaceId, requestReviewId]), value });
          }).catch((loadError) => { if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : t('requestFailed')); });
        } else if (result.review && ['pending', 'stale', 'blocked'].includes(result.review.status)
          && result.review.kind !== 'copy' && !result.review.successorReviewId) {
          setCheckReviewIds([result.review.reviewId]);
          ensureWorkspaceOperationCheck(requestWorkspaceId, [result.review.reviewId]);
        }
      }
    }).catch((loadError) => {
      if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : t('requestFailed'));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [requestMode, requestWorkspaceId, requestReviewId, reload, t, setBatch]);

  const runningBatchId = batch && ['queued', 'applying'].includes(batch.status) ? batch.batchId : null;
  useEffect(() => {
    if (!runningBatchId) return;
    const controller = new AbortController();
    let timer: number | null = null;
    const poll = async () => {
      try {
        const updated = await readWorkspaceOperationBatch(runningBatchId, request.workspaceId, controller.signal);
        if (controller.signal.aborted) return;
        setBatch(updated);
        setError(null);
        if (updated.status === 'queued' || updated.status === 'applying') timer = window.setTimeout(() => { void poll(); }, 1000);
        else {
          window.dispatchEvent(new CustomEvent('notification_summary_updated'));
          if (updated.status === 'applied' || updated.status === 'undone') void useFileStore.getState().refreshVisibleTree();
        }
      } catch (pollError) {
        if (!controller.signal.aborted) {
          setError(pollError instanceof Error ? pollError.message : t('requestFailed'));
          timer = window.setTimeout(() => { void poll(); }, 3000);
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [runningBatchId, request.workspaceId, t, setBatch]);

  const appliedOperationId = data.review?.status === 'applied' ? data.review.operationId : null;
  const appliedAt = data.review?.status === 'applied' ? data.review.updatedAt : null;
  useEffect(() => {
    if (!appliedOperationId) return;
    const controller = new AbortController();
    let retryTimer: number | null = null;
    let projectionRetries = 0;
    const check = async () => {
      try {
        const value = await readWorkspaceOperationUndoAvailability(appliedOperationId, request.workspaceId, controller.signal);
        if (controller.signal.aborted) return;
        if (value.reasonCode === 'UNDO_CONFLICT' && appliedAt && Date.now() - appliedAt < 45_000
          && projectionRetries < 15) {
          // The Yjs link can still be projecting to disk immediately after
          // apply. Keep the action in a checking state for a bounded period.
          projectionRetries += 1;
          retryTimer = window.setTimeout(() => { void check(); }, 2000);
          return;
        }
        setUndoAvailability({ operationId: appliedOperationId, value });
      } catch {
        if (!controller.signal.aborted) setUndoAvailability({ operationId: appliedOperationId,
          value: { available: false, reason: null, reasonCode: 'UNDO_UNAVAILABLE', undoOperationId: null } });
      }
    };
    void check();
    return () => {
      controller.abort();
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [appliedAt, appliedOperationId, request.workspaceId, undoneOperationId, undoReload]);

  const retry = () => {
    setLoading(true);
    setError(null);
    setData({ reviews: [], review: null });
    setReload((value) => value + 1);
  };

  const previewBatch = (reviewIds: string[], fresh = false) => {
    if (batchAction || reviewIds.length === 0) return;
    setError(null);
    setApprovalConflict(null);
    setBatch(null);
    setCheckReviewIds(reviewIds);
    ensureWorkspaceOperationCheck(request.workspaceId, reviewIds, fresh);
  };

  const acceptBatch = async () => {
    if (loading || dataScope !== requestKey || !batch || batchAction || approvalChanged || batch.status !== 'preview' || batch.preview.readiness !== 'ready'
      || checkState && (checkState.status !== 'ready' || !checkSelectionMatches)) return;
    setBatchAction('accept');
    setError(null);
    try {
      setBatch(await acceptWorkspaceOperationBatch({ batchId: batch.batchId, workspaceId: request.workspaceId, planId: batch.planId }));
      forgetWorkspaceOperationCheck(request.workspaceId, checkReviewIds);
      setCheckReviewIds([]);
      window.dispatchEvent(new CustomEvent('notification_summary_updated'));
    } catch (acceptError) {
      const stale = acceptError instanceof WorkspaceOperationReviewClientError
        && ['PREVIEW_STALE', 'BATCH_PLAN_STALE', 'LINK_WRITE_STALE', 'LINK_WRITE_STALE_DOCUMENT'].includes(acceptError.code ?? '');
      if (stale) {
        setApprovalConflict({ key: requestKey, batchId: batch.batchId });
        setBatch(batch);
        forgetWorkspaceOperationCheck(request.workspaceId, checkReviewIds);
      }
      setError(stale ? null : t('actionFailed'));
      const latest = await readWorkspaceOperationBatch(batch.batchId, request.workspaceId).catch(() => null);
      if (latest) setBatch(latest);
    } finally {
      setBatchAction(null);
    }
  };

  const updateBatch = async (batchDecision: 'resume' | 'undo') => {
    if (!batch || batchAction) return;
    setBatchAction(batchDecision);
    setError(null);
    try {
      setBatch(await updateWorkspaceOperationBatch({ batchId: batch.batchId, workspaceId: request.workspaceId,
        planId: batch.planId, action: batchDecision }));
      window.dispatchEvent(new CustomEvent('notification_summary_updated'));
    } catch (updateError) {
      const code = updateError instanceof WorkspaceOperationReviewClientError ? updateError.code : null;
      setError(code === 'BATCH_RESUME_REVIEWER_REQUIRED' ? t('batchResumeReviewerHelp')
        : batchDecision === 'undo' && (code?.startsWith('BATCH_UNDO_') || code === 'LINK_WRITE_STALE' || code === 'LINK_WRITE_STALE_DOCUMENT')
          ? t('batchUndoRefusedHelp') : t('actionFailed'));
    } finally {
      setBatchAction(null);
    }
  };

  const refreshReview = async () => {
    const old = data.review;
    if (!old || batchAction) return;
    if (old.successorReviewId) {
      openWorkspaceOperationReview(old.successorReviewId, request.workspaceId);
      return;
    }
    if (old.kind !== 'copy') {
      previewBatch([old.reviewId], true);
      return;
    }
    setBatchAction('refresh');
    setError(null);
    try {
      const updated = await refreshWorkspaceOperationReview({ reviewId: old.reviewId, workspaceId: request.workspaceId, planId: old.planId });
      setData({ reviews: [], review: updated, previousReview: old });
      setBatch(null);
      setRefreshedFrom(old.reviewId);
      openWorkspaceOperationReview(updated.reviewId, request.workspaceId);
      window.dispatchEvent(new CustomEvent('notification_summary_updated'));
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : t('actionFailed'));
    } finally {
      setBatchAction(null);
    }
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
      if (decision === 'reject') setBatch(null);
      if (updated.batchId) setBatch(await readWorkspaceOperationBatch(updated.batchId, request.workspaceId));
      window.dispatchEvent(new CustomEvent('notification_summary_updated'));
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

  const undo = async () => {
    const operationId = data.review?.operationId;
    if (!operationId || undoAction || !undoAvailability?.value.available
      || undoAvailability.operationId !== operationId) return;
    setUndoAction(true);
    setError(null);
    try {
      const result = await undoWorkspaceOperation(operationId, request.workspaceId);
      if (result.status !== 'applied') throw new Error(result.status === 'needs_recovery'
        ? `${t('undoNeedsRecovery')} ${result.undoOperationId}` : t('undoFailed'));
      setUndoneOperationId(operationId);
      setUndoAvailability({ operationId, value: { available: false,
        reason: null, reasonCode: 'ALREADY_UNDONE', undoOperationId: result.undoOperationId } });
      void useFileStore.getState().refreshVisibleTree();
    } catch (undoError) {
      setError(undoError instanceof Error ? undoError.message : t('undoFailed'));
    } finally {
      setUndoAction(false);
    }
  };

  const dataCurrent = dataScope === requestKey;
  const review = dataCurrent ? data.review : null;
  const reviews = dataCurrent ? data.reviews : [];
  const busyLoading = loading || !dataCurrent;
  const currentUndoAvailability = undoAvailability && review?.operationId === undoAvailability.operationId
    ? undoAvailability.value : null;
  const undoLoading = Boolean(appliedOperationId) && currentUndoAvailability === null;
  const canReject = review && ['pending', 'blocked', 'stale'].includes(review.status)
    && (!batch || ['preview', 'blocked', 'needs_review'].includes(batch.status));
  const canAccept = review?.status === 'pending' && review.preview.readiness === 'ready';
  const eligibleReviews = reviews.filter((item) => ['pending', 'stale', 'blocked'].includes(item.status) && item.kind !== 'copy' && !item.successorReviewId);
  const selectedEligible = eligibleReviews.filter((item) => selectedReviews.has(item.reviewId));
  const checkSelectionMatches = request.mode === 'detail' ? checkReviewIds.length === 1 && checkReviewIds[0] === review?.reviewId
    : JSON.stringify([...checkReviewIds].sort()) === JSON.stringify(selectedEligible.map((item) => item.reviewId).sort());
  const checking = checkState && ['starting', 'queued', 'checking'].includes(checkState.status);
  const checkReviews = review ? [review] : reviews.filter((item) => checkReviewIds.includes(item.reviewId));
  const openDocument = (path: string, workspaceId: string) => {
    void openWorkspaceOperationSourceDocument(path, workspaceId).catch((openError) => {
      setError(openError instanceof Error ? openError.message : t('documentOpenFailed'));
    });
  };
  const toggleSelection = (reviewId: string) => setSelectedReviews((current) => {
    const next = new Set(current);
    if (next.has(reviewId)) next.delete(reviewId); else next.add(reviewId);
    return next;
  });
  return <DialogContent layout="viewport" className="transition-none data-[state=open]:animate-none data-[state=closed]:animate-none" data-testid="workspace-operation-review-center" aria-busy={busyLoading || action !== null || batchAction !== null}>
    <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12 sm:px-6 sm:py-4 sm:pr-14">
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/45 text-muted-foreground"><ClipboardCheck className="size-4" aria-hidden="true" /></span>
        <div className="min-w-0">
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{batch ? t('batchDescription') : request.mode === 'list' ? t('listDescription') : t('detailDescription')}</DialogDescription>
        </div>
      </div>
    </DialogHeader>
    <div className="min-h-0 flex-1 overflow-y-auto">
      {busyLoading ? <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />{t('loading')}</p> : null}
      {error ? <div className="m-4 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alert">
        <span className="min-w-0 flex-1">{error}</span>
        <Button variant="outline" size="sm" onClick={retry}><RefreshCw className="size-4" />{t('retry')}</Button>
      </div> : null}
      {!busyLoading && review && (refreshedFrom || review.previousReviewId) ? <RefreshedReviewNotice review={review} previous={data.previousReview} /> : null}
      {!busyLoading && checkState && !approvalChanged ? <WorkspaceOperationCheckDetails state={checkState} reviews={checkReviews}
        showPaths={!batch} selectionChanged={!checkSelectionMatches} canCheckAgain={request.mode === 'detail' || selectedEligible.length > 0}
        onCheckAgain={() => previewBatch(request.mode === 'list' ? selectedEligible.map((item) => item.reviewId) : checkReviewIds, true)} /> : null}
      {!busyLoading && batch ? <WorkspaceOperationBatchDetails batch={batch} onOpenDocument={openDocument} approvalChanged={approvalChanged} /> : null}
      {!busyLoading && request.mode === 'list' ? <div className="space-y-3 p-4 sm:p-6">
        <details open={!checkState && !batch} className="rounded-lg border" data-testid="workspace-operation-selection">
          <summary className="cursor-pointer px-3 py-3 text-sm font-medium" data-testid="workspace-operation-selection-summary">{t('changeSelection', { count: selectedEligible.length })}</summary>
          <div className="space-y-3 px-3 pb-3">
            {reviews.length === 0 && !error ? <p className="text-sm text-muted-foreground">{t('empty')}</p> : null}
            {eligibleReviews.length > 0 ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 p-3 text-sm">
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" data-testid="workspace-operation-review-select-all" checked={selectedEligible.length === eligibleReviews.length}
                  onChange={(event) => setSelectedReviews(event.target.checked ? new Set(eligibleReviews.map((item) => item.reviewId)) : new Set())} />
                {t('selectAll')}
              </label>
              <span className="text-xs text-muted-foreground">{t('selectedCount', { count: selectedEligible.length })}</span>
            </div> : null}
            {reviews.map((item) => <div key={item.reviewId} className="flex min-w-0 items-start gap-2 rounded-lg border p-3">
              {eligibleReviews.some((eligible) => eligible.reviewId === item.reviewId) ? <input type="checkbox"
                className="mt-1 shrink-0" aria-label={t('selectAction', { path: item.selections.map((selection) => selection.sourcePath).join(', ') })}
                data-testid={`workspace-operation-review-select-${item.reviewId}`} checked={selectedReviews.has(item.reviewId)}
                onChange={() => toggleSelection(item.reviewId)} /> : null}
              <button type="button" className="flex min-w-0 flex-1 items-start gap-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => openWorkspaceOperationReview(item.reviewId, request.workspaceId)}>
              <ClipboardCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 space-y-1">
                <span className="flex flex-wrap items-center gap-2 text-sm font-semibold">{t(`kind_${item.kind}`)} <ReviewStatus review={item} /></span>
                <span className="block break-all font-mono text-xs text-muted-foreground">
                  {item.selections.map((selection) => selection.sourcePath).join(', ')}
                </span>
              </span>
              </button>
            </div>)}
          </div>
        </details>
        <details className="rounded-lg border" data-testid="workspace-operation-backup-details">
          <summary className="cursor-pointer px-3 py-3 text-sm font-medium">{t('fileBackups')}</summary>
          <WorkspaceOperationBackupPanel workspaceId={request.workspaceId} />
        </details>
      </div> : null}
      {!busyLoading && !batch && review && !checking ? <>
        <ReviewDetails review={review} onOpenDocument={openDocument} />
      </> : null}
      {!busyLoading && !batch && review?.status === 'applied' && review.operationId ? <div className="space-y-2 px-4 pb-4 text-xs sm:px-6">
        {undoLoading ? <p role="status" className="text-muted-foreground">{t('undoChecking')}</p> : null}
        {undoneOperationId === review.operationId || currentUndoAvailability?.reasonCode === 'ALREADY_UNDONE'
          ? <p role="status" className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3">{t('undone')}</p>
          : currentUndoAvailability && !currentUndoAvailability.available
            ? <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-3 text-muted-foreground">
              <span className="min-w-0 flex-1">{t(currentUndoAvailability.reasonCode === 'UNDO_CONFLICT'
                ? 'undoConflict' : 'undoUnavailable')}</span>
              <Button variant="outline" size="sm" onClick={() => {
                setUndoAvailability(null);
                setUndoReload((value) => value + 1);
              }}>{t('undoRetry')}</Button>
            </div>
            : null}
      </div> : null}
    </div>
    <DialogFooter className="shrink-0 border-t px-4 py-3 sm:px-6">
      {batch ? <Button variant="ghost" onClick={() => {
        setBatch(null);
        setCheckReviewIds([]);
        if (request.mode === 'detail') openWorkspaceOperationReviewList(request.workspaceId);
        else retry();
      }}>{t('back')}</Button> : null}
      {!batch && request.mode === 'detail' ? <Button variant="ghost" onClick={() => openWorkspaceOperationReviewList(request.workspaceId)}>
        <ArrowLeft className="size-4" />{t('back')}
      </Button> : null}
      {!batch && request.mode === 'list' ? <Button variant="ghost" onClick={retry} disabled={loading}>
        <RefreshCw className="size-4" />{t('retry')}
      </Button> : null}
      <Button variant="outline" onClick={closeWorkspaceOperationReview}>{t('close')}</Button>
      {request.mode === 'list' && ((!checkState && !batch) || !checkSelectionMatches) ? <Button data-testid="workspace-operation-batch-preview" onClick={() => previewBatch(selectedEligible.map((item) => item.reviewId))}
        disabled={batchAction !== null || selectedEligible.length === 0}>{t('reviewSelected')}</Button> : null}
      {!batch && !checkState && review && ['stale', 'blocked'].includes(review.status) ? <Button variant="outline" data-testid="workspace-operation-review-refresh"
        onClick={() => void refreshReview()} disabled={batchAction !== null}>{t(review.successorReviewId ? 'openUpdatedPreview' : 'refreshPreview')}</Button> : null}
      {!busyLoading && !approvalChanged && batch?.status === 'preview' && batch.preview.readiness === 'ready' && (!checkState || checkState.status === 'ready' && checkSelectionMatches) ? <Button data-testid="workspace-operation-batch-accept"
        onClick={() => void acceptBatch()} disabled={batchAction !== null}>{t('acceptBatch')}</Button> : null}
      {batch && !checkState && (approvalChanged || ['blocked', 'needs_review'].includes(batch.status)) ? <Button data-testid="workspace-operation-review-refresh" variant="outline"
        onClick={() => { if (request.mode === 'detail' && data.review && ['pending', 'blocked', 'stale'].includes(data.review.status)) void refreshReview();
          else previewBatch(batch.reviewIds, true); }} disabled={batchAction !== null}>{t('refreshPreview')}</Button> : null}
      {batch && ['needs_recovery', 'failed'].includes(batch.status) ? <Button data-testid="workspace-operation-batch-resume" variant="outline" onClick={() => void updateBatch('resume')}
        disabled={batchAction !== null}>{t(batch.status === 'failed' ? 'retryBatch' : 'resumeBatch')}</Button> : null}
      {batch?.status === 'applied' && batch.undoAvailable ? <Button variant="outline" onClick={() => void updateBatch('undo')}
        disabled={batchAction !== null}>{t('undo')}</Button> : null}
      {canReject && (!batch || request.mode === 'detail' && batch.reviewIds.length === 1) ? <Button variant="outline" onClick={() => void decide('reject')} disabled={action !== null}>
        {action === 'reject' ? <Loader2 className="size-4 animate-spin" /> : null}
        {review.status === 'pending' ? t('reject') : t('dismiss')}
      </Button> : null}
      {!batch && !checkState && canAccept && review.kind !== 'copy' ? <Button data-testid="workspace-operation-batch-preview"
        onClick={() => void previewBatch([review.reviewId])} disabled={batchAction !== null}>{t(review.kind === 'delete' ? 'reviewDelete' : 'reviewSelected')}</Button> : null}
      {!batch && canAccept && review.kind === 'copy' ? <Button onClick={() => void decide('accept')} disabled={action !== null}>
        {action === 'accept' ? <Loader2 className="size-4 animate-spin" /> : null}{t('accept')}
      </Button> : null}
      {!batch && review?.status === 'applied' && review.operationId
        && currentUndoAvailability?.available
        ? <Button variant="outline" onClick={() => void undo()} disabled={undoAction || action !== null}>
          {undoAction ? <Loader2 className="size-4 animate-spin" /> : null}{t('undo')}
        </Button> : null}
    </DialogFooter>
  </DialogContent>;
}
