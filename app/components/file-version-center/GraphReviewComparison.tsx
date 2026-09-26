'use client';

import { AlertTriangle, Check, Clipboard, FileDiff, LoaderCircle, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { useTranslations } from 'next-intl';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { FileVersionCenterRequestV1 } from '@/app/lib/file-version-center/contracts/v1';
import type { FileVersionMutation } from '@/app/lib/file-version-center/action-client';
import type { ProposalReviewContextV1, ProposalReviewGraphSessionV1, ProposalReviewSessionRequestV1,
  PreparedProposalReviewActionV1, ProposalReviewActionApiRequestV1 } from '@/app/lib/file-version-center/contracts/proposal-review-session-v1';
import type { ProposalReviewCompareResponseV1 } from '@/app/lib/file-version-center/contracts/proposal-review-compare-v1';
import type { ProposalActionReceiptV1 } from '@/app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalReviewTransformResponseV1 } from '@/app/lib/file-version-center/contracts/proposal-review-transform-v1';
import { fileVersionTextLines, projectFileVersionTextDiff } from '@/app/lib/file-version-center/text-diff';
import { compareProposalReviewSelection, executeProposalReviewAction,
  previewProposalReviewTransform, readProposalReviewActionStatus, readProposalReviewSession,
  ProposalReviewClientError } from '@/app/lib/file-version-center/proposal-review-client';
import { openedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';
import { exactGraphReviewAction, forgetGraphReviewAction, graphReviewActionStorageKey,
  graphReviewPostInFlight, markGraphReviewPost, readGraphReviewActionIdentity,
  rememberGraphReviewAction } from './graph-review-action-state';
import type { ProposalReviewActionStatusRequestV1 } from '@/app/lib/file-version-center/contracts/proposal-review-session-v1';

type GraphSelection = ProposalReviewSessionRequestV1['selection'];
type GraphAction = 'accept' | 'reject' | 'branchReject' | 'completeSatisfied';
type TransformKind = 'detach' | 'replace';
type PendingAction = { action: GraphAction; prepared: PreparedProposalReviewActionV1; sessionKey: string };
type TransformPreviewState = { sessionKey: string; generation: number; preview: ProposalReviewTransformResponseV1 };
export type GraphReviewCardStatus = { operationId: string; status: ProposalReviewGraphSessionV1['status']; reasonCode: string | null };
const TRANSIENT_REVIEW_REASONS = new Set([
  'PROPOSAL_CURRENT_CHANGED', 'PROPOSAL_GRAPH_CHANGED', 'PROPOSAL_FENCE_EXPIRED',
]);

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function statusKey(status: ProposalReviewGraphSessionV1['status']): string {
  return `graph.status.${status}`;
}

function reasonKey(reason: string | null): string {
  return reason ? `graph.reason.${reason}` : 'graph.reason.unknown';
}

function timelineMutationForAction(actionType: string): FileVersionMutation | undefined {
  if (actionType === 'reject' || actionType === 'branch_reject' || actionType === 'replace') return 'reject';
  if (actionType === 'accept' || actionType === 'batch_accept' || actionType === 'complete_satisfied') return 'accept';
  return undefined;
}

function GraphDiagnosis({ diagnosis, session, checkedAt }: { diagnosis: {
  reasonCode: string | null; phase: string; correlationId: string | null; timestamp: number; buildMarker: string | null;
}; session?: ProposalReviewGraphSessionV1; checkedAt?: number | null }) {
  const t = useTranslations('fileVersionCenter');
  const [copied, setCopied] = useState(false);
  const proof = session?.compare?.binding?.current;
  const shortProof = proof ? {
    revisionId: proof.revisionId,
    contentHash: `${proof.contentHash.slice(0, 12)}…`,
    structureHash: `${proof.structureHash.slice(0, 12)}…`,
    stateVectorHash: `${proof.stateVectorHash.slice(0, 12)}…`,
    deleteSetHash: `${proof.deleteSetHash.slice(0, 12)}…`,
    fullStateHash: `${proof.fullStateHash.slice(0, 12)}…`,
  } : null;
  const safeDiagnostic = JSON.stringify({
    reasonCode: diagnosis.reasonCode,
    phase: diagnosis.phase,
    evaluationId: session?.compare?.binding?.evaluationId ?? null,
    selectedProposalIds: session?.selectedProposalIds ?? [],
    currentProof: shortProof,
    targetKind: session?.target.kind ?? null,
    availableActions: session ? Object.keys(session.actions) : [],
    checkedAt: checkedAt ?? diagnosis.timestamp,
    correlationId: diagnosis.correlationId,
    timestamp: diagnosis.timestamp,
    buildMarker: diagnosis.buildMarker,
  }, null, 2);
  return (
    <details className="rounded-lg border bg-muted/20 px-3 py-2.5 text-xs" data-testid="graph-review-diagnostics">
      <summary className="cursor-pointer font-medium text-muted-foreground">{t('graph.diagnostics')}</summary>
      <div className="mt-2 flex items-start justify-between gap-2">
        <pre className="min-w-0 overflow-auto whitespace-pre-wrap break-all font-mono leading-5 text-muted-foreground">{safeDiagnostic}</pre>
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => {
          if (!navigator.clipboard?.writeText) return;
          void navigator.clipboard.writeText(safeDiagnostic).then(() => setCopied(true)).catch(() => setCopied(false));
        }}>
          <Clipboard className="size-3.5" aria-hidden="true" />{copied ? t('graph.copied') : t('graph.copy')}
        </Button>
      </div>
    </details>
  );
}

function GraphHunks({ hunks }: { hunks: ProposalReviewCompareResponseV1['hunks'] }) {
  const t = useTranslations('fileVersionCenter');
  if (!hunks.length) return <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">{t('graph.noVisibleHunks')}</p>;
  return <div className="overflow-hidden rounded-lg border" data-testid="graph-review-hunks">
    {hunks.map((hunk) => <section key={hunk.id} className="border-b last:border-b-0">
      <div className="bg-muted/50 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines}
      </div>
      <pre className="overflow-x-auto text-xs leading-5">{hunk.lines.map((line, index) => <span
        key={`${hunk.id}:${index}`}
        className={`grid grid-cols-[3rem_1rem_minmax(max-content,1fr)] border-t border-border/40 ${line.kind === 'addition'
          ? 'bg-emerald-500/[0.08] text-emerald-800 dark:text-emerald-200'
          : line.kind === 'deletion' ? 'bg-destructive/[0.07] text-destructive' : ''}`}
      >
        <span className="border-r bg-muted/20 px-2 text-right tabular-nums text-muted-foreground">{line.newLineNumber ?? line.oldLineNumber ?? ''}</span>
        <span className="text-center">{line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ' '}</span>
        <span className="whitespace-pre px-2">{line.text || ' '}</span>
      </span>)}</pre>
    </section>)}
  </div>;
}

function GraphTransformPreview({ preview, busy, onCancel, onConfirm, focusRef }: {
  preview: ProposalReviewTransformResponseV1; busy: boolean; onCancel: () => void; onConfirm: () => void;
  focusRef: Ref<HTMLElement>;
}) {
  const t = useTranslations('fileVersionCenter');
  const diff = useMemo(() => preview.beforeContent.length + preview.proposedContent.length <= 32_768
    ? projectFileVersionTextDiff(fileVersionTextLines(preview.beforeContent), fileVersionTextLines(preview.proposedContent))
    : null, [preview.beforeContent, preview.proposedContent]);
  return <section ref={focusRef} tabIndex={-1} className="space-y-3 rounded-lg border border-violet-500/30 bg-violet-500/[0.035] p-3 sm:p-4"
    data-testid="graph-review-transform-preview" aria-label={t('graph.transform.heading')}>
    <div>
      <h3 className="text-sm font-semibold">{t(`graph.transform.${preview.kind}.heading`)}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t(`graph.transform.${preview.kind}.consequence`)}</p>
    </div>
    {diff && !diff.lineTextTruncated ? <>
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="outline" className="border-emerald-500/30 text-emerald-700 dark:text-emerald-200">+{diff.summary.additions}</Badge>
        <Badge variant="outline" className="border-destructive/30 text-destructive">−{diff.summary.deletions}</Badge>
      </div>
      <GraphHunks hunks={diff.hunks} />
    </> : <p className="text-xs text-muted-foreground">{t('graph.transform.fullComparison')}</p>}
    <div className="grid min-w-0 gap-2 md:grid-cols-2" data-testid="graph-review-transform-full-content">
      {([['before', preview.beforeContent], ['proposed', preview.proposedContent]] as const).map(([side, content]) =>
        <div key={side} className="min-w-0 overflow-hidden rounded-md border bg-background">
          <h4 className="border-b bg-muted/35 px-3 py-2 text-xs font-medium">{t(side === 'before'
            ? `graph.transform.${preview.kind}.before` : 'graph.transform.proposed')}</h4>
          <pre className="max-h-[42dvh] min-w-0 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5">{content || ' '}</pre>
        </div>)}
    </div>
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>{t('actions.cancel')}</Button>
      <Button type="button" size="sm" disabled={busy} onClick={onConfirm}>
        <Check className="size-4" aria-hidden="true" />{t(`graph.transform.${preview.kind}.confirm`)}
      </Button>
    </div>
  </section>;
}

function GraphContext({ context, inspectParent, inspectProposal, inspectAlternative, disabled }: {
  context: ProposalReviewContextV1;
  inspectParent: (proposalId: string) => void;
  inspectProposal: (proposalId: string) => void;
  inspectAlternative: (proposalId: string) => void;
  disabled: boolean;
}) {
  const t = useTranslations('fileVersionCenter');
  const byId = new Map(context.proposals.map((proposal) => [proposal.proposalId, proposal]));
  const selected = new Set(context.selectedProposalIds);
  const dependencies = new Set(context.dependencyProposalIds);
  const closing = new Set(context.closingAlternativeProposalIds);
  const apply = new Set(context.applyProposalIds);
  const depth = (proposalId: string) => {
    let current = byId.get(proposalId);
    let result = 0;
    const seen = new Set<string>();
    while (current?.parentProposalId && byId.has(current.parentProposalId) && !seen.has(current.parentProposalId)) {
      seen.add(current.parentProposalId);
      current = byId.get(current.parentProposalId);
      result += 1;
    }
    return Math.min(result, 6);
  };
  const groups = new Map<string, typeof context.proposals>();
  for (const proposal of context.proposals) {
    const rows = groups.get(proposal.rootProposalId) ?? [];
    rows.push(proposal);
    groups.set(proposal.rootProposalId, rows);
  }
  return <section className="space-y-3 rounded-lg border bg-muted/15 p-3" aria-label={t('graph.context.heading')} data-testid="graph-review-context">
    <div>
      <h3 className="text-sm font-semibold">{t('graph.context.heading')}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{t('graph.context.description')}</p>
    </div>
    <div className="flex flex-wrap gap-1.5 text-xs">
      {context.dependencyProposalIds.length > 0 ? <Badge variant="outline" className="border-sky-500/35 text-sky-800 dark:text-sky-200">
        {t('graph.context.prerequisites', { count: context.dependencyProposalIds.length })}
      </Badge> : null}
      {context.closingAlternativeProposalIds.length > 0 ? <Badge variant="outline" className="border-amber-500/35 text-amber-800 dark:text-amber-200">
        {t('graph.context.alternativesClose', { count: context.closingAlternativeProposalIds.length })}
      </Badge> : null}
    </div>
    {context.dependencyProposalIds.length > 0 ? <p className="rounded-md border border-sky-500/25 bg-sky-500/[0.05] px-3 py-2 text-xs text-sky-900 dark:text-sky-100">
      {t('graph.context.parentIncluded', { count: context.dependencyProposalIds.length })}
    </p> : null}
    <div className="max-h-64 space-y-3 overflow-y-auto">
      {[...groups].map(([rootId, proposals]) => <div key={rootId} className="overflow-hidden rounded-md border bg-background">
        <div className="border-b bg-muted/35 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
          {t('graph.context.branch')} · <span className="font-mono">{rootId.slice(0, 12)}</span>
        </div>
        <ol>{proposals.slice().sort((a, b) => depth(a.proposalId) - depth(b.proposalId) || a.createdAt - b.createdAt)
          .map((proposal) => <li key={proposal.proposalId} className="border-b last:border-b-0"
            style={{ paddingInlineStart: `${0.75 + depth(proposal.proposalId) * 1.1}rem` }}>
            <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{t(`graph.card.${proposal.relation}`)}</p>
                <p className="truncate font-mono text-[11px] text-muted-foreground" title={proposal.proposalId}>
                  {t(`graph.context.lifecycle.${proposal.lifecycle}`)} · {proposal.proposalId.slice(0, 12)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {selected.has(proposal.proposalId) ? <Badge variant="outline">{t('graph.context.selected')}</Badge> : null}
                {dependencies.has(proposal.proposalId) ? <Badge variant="outline" className="border-sky-500/35 text-sky-800 dark:text-sky-200">{t('graph.context.prerequisite')}</Badge> : null}
                {apply.has(proposal.proposalId) && !selected.has(proposal.proposalId) && !dependencies.has(proposal.proposalId)
                  ? <Badge variant="outline">{t('graph.context.included')}</Badge> : null}
                {closing.has(proposal.proposalId) ? <Badge variant="outline" className="border-amber-500/35 text-amber-800 dark:text-amber-200">{t('graph.context.closes')}</Badge> : null}
                {proposal.parentProposalId && byId.has(proposal.parentProposalId) ? <Button type="button" variant="ghost" size="sm"
                  disabled={disabled} onClick={() => inspectParent(proposal.parentProposalId!)}>{t('graph.context.inspectParent')}</Button> : null}
                {!selected.has(proposal.proposalId) && proposal.lifecycle === 'open'
                  && proposal.relation !== 'alternative' && !proposal.relationships.choiceGroupId
                  ? <Button type="button" variant="outline" size="sm" disabled={disabled}
                    onClick={() => inspectProposal(proposal.proposalId)}>{proposal.relation === 'dependency'
                      ? t('graph.context.inspectWithParent') : t('graph.context.inspectProposal')}</Button> : null}
                {!selected.has(proposal.proposalId) && proposal.lifecycle === 'open'
                  && (proposal.relation === 'alternative' || proposal.relationships.choiceGroupId)
                  ? <Button type="button" variant="outline" size="sm" disabled={disabled}
                    onClick={() => inspectAlternative(proposal.proposalId)}>{t('graph.context.inspectAlternative')}</Button> : null}
              </div>
            </div>
          </li>)}</ol>
      </div>)}
    </div>
  </section>;
}

export function GraphReviewComparison({
  request,
  document,
  operationId,
  legacy,
  isRevalidating,
  isStale,
  onTimelineInvalidate,
  onContinue,
  onReviewStatus,
}: {
  request: FileVersionCenterRequestV1;
  document: { workspaceId: string; lineageId: string; documentId?: string | null };
  operationId: string;
  legacy: ReactNode;
  isRevalidating: boolean;
  isStale: boolean;
  onTimelineInvalidate: (action?: FileVersionMutation) => Promise<void> | void;
  onContinue: () => void;
  onReviewStatus?: (status: GraphReviewCardStatus | null) => void;
}) {
  const t = useTranslations('fileVersionCenter');
  const [selection, setSelection] = useState<GraphSelection>({ kind: 'operation', operationId });
  const [allIntent, setAllIntent] = useState(false);
  const [frozenAllIds, setFrozenAllIds] = useState<string[] | null>(null);
  const uncertainKey = graphReviewActionStorageKey(openedDocumentAuthScope(), document);
  const [snapshot, setSnapshot] = useState<{ key: string; value: ProposalReviewGraphSessionV1 | { mode: 'legacy' } } | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [hostInvalidated, setHostInvalidated] = useState(false);
  const [reload, setReload] = useState(0);
  const [compare, setCompare] = useState<ProposalReviewCompareResponseV1 | null>(null);
  const [compareBusy, setCompareBusy] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [actionRequest, setActionRequest] = useState<ProposalReviewActionApiRequestV1 | null>(null);
  const [actionIdentity, setActionIdentity] = useState<ProposalReviewActionStatusRequestV1 | null>(null);
  const [statusReload, setStatusReload] = useState(0);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusCheckedAt, setStatusCheckedAt] = useState<number | null>(null);
  const [receiptPhase, setReceiptPhase] = useState<ProposalActionReceiptV1['phase'] | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [transformPreview, setTransformPreview] = useState<TransformPreviewState | null>(null);
  const [transformBusy, setTransformBusy] = useState(false);
  const [transformError, setTransformError] = useState<Error | null>(null);
  const generationRef = useRef(0);
  const pageAbortRef = useRef<AbortController | null>(null);
  const transformAbortRef = useRef<AbortController | null>(null);
  const actionBusyRef = useRef(false);
  const frozenAllRef = useRef<string[] | null>(null);
  const invalidationSequenceRef = useRef(0);
  const invalidationRef = useRef({ stale: false, revalidating: false, pending: false });
  const reviewAllButtonRef = useRef<HTMLButtonElement>(null);
  const thisChangeButtonRef = useRef<HTMLButtonElement>(null);
  const selectionStatusRef = useRef<HTMLDivElement>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const transformPreviewFocusRef = useRef<HTMLElement>(null);
  const continueButtonRef = useRef<HTMLButtonElement>(null);
  const selectionFocusRequestedRef = useRef(false);
  const confirmationFocusRequestedRef = useRef(false);
  const transformFocusRequestedRef = useRef(false);
  const pendingReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const transformReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const cancelReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const key = useMemo(() => JSON.stringify([request.target, selection]), [request.target, selection]);
  const session = snapshot?.key === key && snapshot.value.mode === 'graph' ? snapshot.value : null;
  const legacyMode = snapshot?.key === key && snapshot.value.mode === 'legacy';
  const displayCompare = compare ?? session?.compare ?? null;
  const reviewPending = loading || hostInvalidated || isRevalidating || isStale || Boolean(loadError) || snapshot?.key !== key;
  const selectedOpen = session?.context?.selectedProposalIds.every((id) =>
    session.context?.proposals.some((proposal) => proposal.proposalId === id && proposal.lifecycle === 'open')) ?? false;
  const reviewActionAllowed = Boolean(session?.capability.write && session.context && selectedOpen)
    && !reviewPending && !actionBusy && !actionIdentity;
  const metadataActionAllowed = reviewActionAllowed && !transformBusy && !transformPreview;
  const contentActionAllowed = metadataActionAllowed && session?.context?.reasonCode === null;
  const transformActionAllowed = reviewActionAllowed && session?.context?.reasonCode === null
    && session?.selectedProposalIds.length === 1 && !allIntent && !transformBusy && !transformPreview;
  useLayoutEffect(() => {
    if (cancelReturnFocusRef.current && !pending && !transformPreview) {
      const target = cancelReturnFocusRef.current;
      cancelReturnFocusRef.current = null;
      (target.isConnected && !target.disabled ? target : continueButtonRef.current)?.focus({ preventScroll: true });
    }
    if (confirmationFocusRequestedRef.current && pending && !actionRequest) {
      confirmationFocusRequestedRef.current = false;
      confirmationRef.current?.focus({ preventScroll: true });
    }
    if (transformFocusRequestedRef.current && transformPreview?.sessionKey === key && !reviewPending) {
      transformFocusRequestedRef.current = false;
      transformPreviewFocusRef.current?.focus({ preventScroll: true });
    }
    if (selectionFocusRequestedRef.current) {
      if (session) {
        const target = allIntent ? thisChangeButtonRef.current : reviewAllButtonRef.current;
        if (target) {
          selectionFocusRequestedRef.current = false;
          target.focus({ preventScroll: true });
        }
      } else if (selectionStatusRef.current) {
        selectionStatusRef.current.focus({ preventScroll: true });
        if (loadError || legacyMode) selectionFocusRequestedRef.current = false;
      }
    }
  }, [actionRequest, allIntent, key, legacyMode, loadError, pending, reviewPending, session, transformPreview]);
  const reevaluateAfterFailedAction = useCallback(async () => {
    setHostInvalidated(true);
    try { await onTimelineInvalidate(); }
    catch { setLoadError(new Error(t('graph.loadFailed'))); }
    finally { setReload((value) => value + 1); }
  }, [onTimelineInvalidate, t]);

  useEffect(() => {
    if (!session || selection.kind !== 'operation' || reviewPending) {
      onReviewStatus?.(null);
      return;
    }
    onReviewStatus?.({ operationId, status: session.status, reasonCode: session.reasonCode });
    return () => onReviewStatus?.(null);
  }, [onReviewStatus, operationId, reviewPending, selection.kind, session]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const saved = readGraphReviewActionIdentity(uncertainKey);
      setActionIdentity(saved);
      setActionRequest(exactGraphReviewAction(uncertainKey));
    });
    return () => { cancelled = true; };
  }, [uncertainKey]);

  useEffect(() => {
    if (!actionIdentity) return;
    const controller = new AbortController();
    Promise.resolve().then(() => {
      if (!controller.signal.aborted) { setStatusBusy(true); setStatusError(null); }
    });
    void readProposalReviewActionStatus(actionIdentity, controller.signal).then(({ receipt, checkedAt }) => {
      if (controller.signal.aborted) return;
      setStatusCheckedAt(checkedAt);
      const expectedCreation = exactGraphReviewAction(uncertainKey)?.action.creation?.proposalId;
      if (receipt?.phase === 'succeeded' && expectedCreation
        && (receipt.result.kind !== 'metadata_only' || receipt.result.createdProposalIds[0] !== expectedCreation)) {
        setReceiptPhase(null);
        setStatusError(t('graph.receiptMismatch'));
        return;
      }
      setReceiptPhase(receipt?.phase ?? null);
      if (receipt?.phase === 'succeeded' || receipt?.phase === 'failed'
        || receipt === null && checkedAt >= actionIdentity.approvalExpiresAt && !graphReviewPostInFlight(uncertainKey)) {
        // The recovered receipt is authoritative, but the visible comparison
        // still belongs to the old graph/current proof until re-evaluation.
        setHostInvalidated(true);
        setPending(null);
        setTransformPreview(null);
        forgetGraphReviewAction(uncertainKey);
        setActionIdentity(null);
        setActionRequest(null);
        if (receipt?.phase === 'succeeded') {
          void Promise.resolve().then(() => onTimelineInvalidate(timelineMutationForAction(receipt.actionType)))
            .then(() => setReload((value) => value + 1))
            .catch(() => setLoadError(new Error(t('graph.loadFailed'))));
        } else if (receipt?.phase === 'failed') {
          setActionError(new Error(t('graph.actionFailed')));
          void reevaluateAfterFailedAction();
        } else if (receipt === null) {
          setReload((value) => value + 1);
        }
      } else if (receipt === null) setStatusError(t('graph.statusNotDetermined'));
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && !isAbort(error)) setStatusError(t('graph.statusFailed'));
    }).finally(() => { if (!controller.signal.aborted) setStatusBusy(false); });
    return () => controller.abort();
  }, [actionIdentity, onTimelineInvalidate, reevaluateAfterFailedAction, statusReload, t, uncertainKey]);

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++generationRef.current;
    const invalidationSequence = invalidationSequenceRef.current;
    pageAbortRef.current?.abort();
    pageAbortRef.current = null;
    transformAbortRef.current?.abort();
    transformAbortRef.current = null;
    const active = () => !controller.signal.aborted && generation === generationRef.current;
    Promise.resolve().then(() => {
      if (!active()) return;
      setLoading(true);
      setLoadError(null);
      setCompare(null);
      setCompareBusy(false);
      setCompareError(null);
      setPending(null);
      setTransformPreview(null);
      setTransformBusy(false);
      setTransformError(null);
      confirmationFocusRequestedRef.current = false;
      transformFocusRequestedRef.current = false;
    });
    const read = async () => {
      const effectiveSelection: GraphSelection = selection.kind === 'all' && frozenAllRef.current
        ? { kind: 'proposals', proposalIds: frozenAllRef.current } : selection;
      const input = { contractVersion: 1 as const, target: request.target, selection: effectiveSelection };
      let first;
      try { first = await readProposalReviewSession(input, controller.signal); }
      catch (error) {
        if (error instanceof ProposalReviewClientError && TRANSIENT_REVIEW_REASONS.has(error.code) && active()
          && (selection.kind !== 'all' || frozenAllRef.current)) return readProposalReviewSession(input, controller.signal);
        throw error;
      }
      if (first.mode === 'graph' && selection.kind === 'all' && !frozenAllRef.current && active()) {
        frozenAllRef.current = [...first.selectedProposalIds];
        setFrozenAllIds([...first.selectedProposalIds]);
      }
      if (first.mode === 'graph' && first.reasonCode && TRANSIENT_REVIEW_REASONS.has(first.reasonCode) && active()) {
        const retrySelection: GraphSelection = selection.kind === 'all' && frozenAllRef.current
          ? { kind: 'proposals', proposalIds: frozenAllRef.current } : effectiveSelection;
        return readProposalReviewSession({ ...input, selection: retrySelection }, controller.signal);
      }
      return first;
    };
    void read()
      .then((value) => {
        if (!active()) return;
        const expectedIds = selection.kind === 'proposals' ? selection.proposalIds
          : selection.kind === 'all' ? frozenAllRef.current : null;
        if (expectedIds && value.mode === 'graph'
          && JSON.stringify(value.selectedProposalIds) !== JSON.stringify(expectedIds)) {
          throw new Error(t('graph.selectionChanged'));
        }
        if (selection.kind === 'all' && value.mode === 'graph' && !frozenAllRef.current) {
          // The first full-document read freezes the exact server-selected IDs.
          frozenAllRef.current = [...value.selectedProposalIds];
          setFrozenAllIds([...value.selectedProposalIds]);
        }
        setSnapshot({ key, value });
        setLoading(false);
        if (invalidationSequence === invalidationSequenceRef.current && !invalidationRef.current.pending
          && !invalidationRef.current.stale && !invalidationRef.current.revalidating) setHostInvalidated(false);
      }).catch((error: unknown) => {
        if (!active() || isAbort(error)) return;
        if (error instanceof ProposalReviewClientError
          && (error.status === 401 || error.status === 403 || error.status === 404
            || error.code === 'PROPOSAL_ACCESS_DENIED' || error.code === 'FVRC_ACCESS_DENIED'
            || error.code === 'FVRC_NOT_FOUND' || error.code === 'PROPOSAL_SCOPE_MISMATCH')) {
          // Review access can be revoked while the host timeline is still
          // visible. Purge its previously authorized graph payload and diff.
          setSnapshot(null);
          setCompare(null);
          setPending(null);
          setTransformPreview(null);
          pageAbortRef.current?.abort();
          transformAbortRef.current?.abort();
        }
        setLoadError(error instanceof Error ? error : new Error(t('graph.loadFailed')));
        setLoading(false);
      });
    return () => { controller.abort(); generationRef.current += 1; pageAbortRef.current?.abort(); transformAbortRef.current?.abort(); };
  }, [key, reload, request.target, selection, t]);

  useEffect(() => {
    const state = invalidationRef.current;
    const staleRise = isStale && !state.stale;
    const revalidationRise = isRevalidating && !state.revalidating;
    if (staleRise || revalidationRise) {
      state.pending = true;
      invalidationSequenceRef.current += 1;
      setHostInvalidated(true);
    }
    state.stale = isStale;
    state.revalidating = isRevalidating;
    if (staleRise && !isRevalidating) {
      void Promise.resolve().then(() => onTimelineInvalidate()).catch(() => {
        setLoadError(new Error(t('graph.loadFailed')));
      });
    }
    if (!isStale && !isRevalidating && state.pending) {
      state.pending = false;
      setReload((value) => value + 1);
    }
  }, [isRevalidating, isStale, onTimelineInvalidate, t]);

  const refresh = useCallback(() => {
    setActionError(null);
    if (isStale) {
      void Promise.resolve().then(() => onTimelineInvalidate())
        .catch(() => setLoadError(new Error(t('graph.loadFailed'))))
        .finally(() => setReload((value) => value + 1));
    } else setReload((value) => value + 1);
  }, [isStale, onTimelineInvalidate, t]);

  const changeSelection = useCallback((next: GraphSelection, returnToFrozenAll = false) => {
    if (actionBusyRef.current || actionIdentity) return;
    setActionError(null);
    if (next.kind === 'all') { frozenAllRef.current = null; setFrozenAllIds(null); }
    setAllIntent(next.kind === 'all' || returnToFrozenAll);
    setSelection(next);
  }, [actionIdentity]);

  const loadMore = useCallback(async () => {
    if (!session || !displayCompare?.binding || !displayCompare.page.hasMore || !displayCompare.page.nextCursor
      || compareBusy || reviewPending || pageAbortRef.current) return;
    const controller = new AbortController();
    const generation = generationRef.current;
    pageAbortRef.current = controller;
    setCompareBusy(true);
    setCompareError(null);
    try {
      const next = await compareProposalReviewSelection({
        contractVersion: 1, target: session.target, selectedProposalIds: session.selectedProposalIds,
        binding: displayCompare.binding, cursor: displayCompare.page.nextCursor, limit: 64,
      }, controller.signal);
      if (controller.signal.aborted || generation !== generationRef.current) return;
      if (!next.binding || JSON.stringify(next.binding) !== JSON.stringify(displayCompare.binding)) {
        throw new Error(t('graph.comparisonChanged'));
      }
      setCompare({ ...next, hunks: [...displayCompare.hunks, ...next.hunks] });
    } catch (error) {
      if (!controller.signal.aborted && generation === generationRef.current && !isAbort(error)) {
        setCompareError(error instanceof Error ? error.message : t('hunksFailed'));
      }
    } finally {
      if (pageAbortRef.current === controller) pageAbortRef.current = null;
      if (generation === generationRef.current) setCompareBusy(false);
    }
  }, [compareBusy, displayCompare, reviewPending, session, t]);

  const startTransform = async (kind: TransformKind) => {
    if (!transformActionAllowed || !session?.context) return;
    const sourceProposalId = session.selectedProposalIds[0];
    const generation = generationRef.current;
    const controller = new AbortController();
    transformAbortRef.current?.abort();
    transformAbortRef.current = controller;
    setTransformBusy(true);
    setTransformError(null);
    try {
      const preview = await previewProposalReviewTransform({ contractVersion: 1, target: request.target,
        sourceProposalId, kind, expectedGraphRevision: session.context.graphRevision }, controller.signal);
      if (!controller.signal.aborted && generation === generationRef.current) {
        setTransformPreview({ sessionKey: key, generation, preview });
      }
    } catch (error) {
      if (!controller.signal.aborted && generation === generationRef.current && !isAbort(error)) {
        transformFocusRequestedRef.current = false;
        setTransformError(error instanceof Error ? error : new Error(t('graph.transform.failed')));
      }
    } finally {
      if (transformAbortRef.current === controller) transformAbortRef.current = null;
      if (generation === generationRef.current) setTransformBusy(false);
    }
  };

  const execute = useCallback(async (action: ProposalReviewActionApiRequestV1) => {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true;
    markGraphReviewPost(uncertainKey, true);
    setActionBusy(true);
    setActionError(null);
    try {
      const receipt = await executeProposalReviewAction(action);
      setStatusError(null);
      if (receipt.phase === 'succeeded' && action.action.creation
        && (receipt.result.kind !== 'metadata_only'
          || receipt.result.createdProposalIds[0] !== action.action.creation.proposalId)) {
        setReceiptPhase(null);
        setActionError(new Error(t('graph.receiptMismatch')));
        setStatusReload((value) => value + 1);
        return;
      }
      setReceiptPhase(receipt.phase);
      if (receipt.phase === 'succeeded') {
        setHostInvalidated(true);
        forgetGraphReviewAction(uncertainKey);
        setActionIdentity(null);
        setActionRequest(null);
        setPending(null);
        await onTimelineInvalidate(timelineMutationForAction(action.action.fence.actionType));
        setReload((value) => value + 1);
      } else if (receipt.phase === 'failed') {
        forgetGraphReviewAction(uncertainKey);
        setActionIdentity(null);
        setActionRequest(null);
        setPending(null);
        setActionError(new Error(t('graph.actionFailed')));
        await reevaluateAfterFailedAction();
      } else {
        setActionError(null);
        setStatusReload((value) => value + 1);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error : new Error(t('graph.actionFailed')));
    } finally {
      markGraphReviewPost(uncertainKey, false);
      actionBusyRef.current = false;
      setActionBusy(false);
    }
  }, [onTimelineInvalidate, reevaluateAfterFailedAction, t, uncertainKey]);

  const confirm = () => {
    if (!pending || !session || pending.sessionKey !== key) return;
    if (pending.action === 'accept' || pending.action === 'completeSatisfied') {
      if (!contentActionAllowed) return;
    } else if (!metadataActionAllowed) return;
    const action: ProposalReviewActionApiRequestV1 = {
      contractVersion: 1,
      target: request.target,
      action: { contractVersion: 1, fence: pending.prepared.fence, fenceToken: pending.prepared.fenceToken,
        idempotencyKey: crypto.randomUUID(), creation: null },
    };
    try { setActionIdentity(rememberGraphReviewAction(uncertainKey, action)); }
    catch { setActionError(new Error(t('graph.recoveryUnavailable'))); return; }
    setActionRequest(action);
    void execute(action);
  };

  const confirmTransform = () => {
    if (!transformPreview || !reviewActionAllowed || !session || reviewPending
      || transformPreview.sessionKey !== key || transformPreview.generation !== generationRef.current) return;
    const { preview } = transformPreview;
    if (session.context?.reasonCode !== null || session.selectedProposalIds.length !== 1
      || session.selectedProposalIds[0] !== preview.sourceProposalId) return;
    const action: ProposalReviewActionApiRequestV1 = {
      contractVersion: 1, target: request.target,
      action: { contractVersion: 1, fence: preview.prepared.fence, fenceToken: preview.prepared.fenceToken,
        idempotencyKey: crypto.randomUUID(), creation: preview.prepared.creation },
    };
    try { setActionIdentity(rememberGraphReviewAction(uncertainKey, action)); }
    catch { setActionError(new Error(t('graph.recoveryUnavailable'))); return; }
    setActionRequest(action);
    setTransformPreview(null);
    void execute(action);
  };

  if (legacyMode && selection.kind === 'operation' && !actionIdentity && !reviewPending) return <>{legacy}</>;
  if (actionIdentity && !session) return <div className="flex flex-1 items-center justify-center p-5">
    <Alert className="max-w-xl rounded-lg" data-testid="graph-review-pending-action">
      <AlertTriangle aria-hidden="true" /><AlertTitle>{actionBusy ? t('graph.durability.submitting')
        : receiptPhase ? t(`graph.durability.${receiptPhase}`) : t('graph.durability.unconfirmed')}</AlertTitle>
      <AlertDescription className="space-x-2"><Button type="button" variant="outline" size="sm" className="mt-3" disabled={statusBusy}
        onClick={() => setStatusReload((value) => value + 1)}>{t('graph.checkStatus')}</Button>
        {actionRequest ? <Button type="button" variant="outline" size="sm" disabled={actionBusy}
          onClick={() => { void execute(actionRequest); }}>{t('graph.retrySameAction')}</Button> : null}
        {statusError ? <p role="alert">{statusError}</p> : null}
      </AlertDescription>
    </Alert>
  </div>;
  const showError = loadError instanceof ProposalReviewClientError
    ? loadError.code.startsWith('PROPOSAL_') ? t(reasonKey(loadError.code)) : t('graph.transportError')
    : loadError?.message ?? (legacyMode && selection.kind !== 'operation' ? t('graph.legacyBatchUnavailable') : null);
  if (!session && !showError) return <div ref={selectionStatusRef} tabIndex={-1} className="flex flex-1 items-center justify-center p-6" role="status">
    <LoaderCircle className="mr-2 size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />{t('graph.loading')}
  </div>;
  if (!session) return <div ref={selectionStatusRef} tabIndex={-1} className="flex flex-1 items-center justify-center p-5">
    <Alert variant="destructive" className="max-w-xl rounded-lg" data-testid="graph-review-load-error">
      <ShieldAlert aria-hidden="true" /><AlertTitle>{t('graph.loadFailed')}</AlertTitle>
      <AlertDescription><p>{showError}</p>{loadError instanceof ProposalReviewClientError ? <div className="mt-3"><GraphDiagnosis diagnosis={loadError.diagnosis} /></div> : null}<Button type="button" variant="outline" size="sm" className="mt-3" onClick={refresh}>
        <RefreshCw className="size-4" aria-hidden="true" />{t('retry')}
      </Button></AlertDescription>
    </Alert>
  </div>;

  const status = session.status;
  const clean = status === 'clean' || status === 'clean_rebased';
  const available = clean && displayCompare?.diagnosis.availability === 'available'
    && displayCompare.candidate.contentAvailable && displayCompare.binding;
  const provenNoEffect = (status === 'satisfied_elsewhere' || status === 'empty_effect')
    && displayCompare?.status === status && displayCompare.diagnosis.availability === 'available'
    && displayCompare.candidate.noEffect && Boolean(displayCompare.binding)
    && displayCompare.summary.additions === 0 && displayCompare.summary.deletions === 0
    && displayCompare.hunks.length === 0 && !displayCompare.page.hasMore && displayCompare.page.nextCursor === null;
  const preparedActions = session.actions;
  const isBatch = session.selectedProposalIds.length > 1 || allIntent;
  const reviewReason = (reason: string | null) => reason === 'PROPOSAL_BATCH_CONFLICT'
    && session.selectedProposalIds.length === 1
    ? t('graph.singleCurrentConflict') : t(reasonKey(reason));
  const pendingAllowed = pending?.action === 'accept' || pending?.action === 'completeSatisfied'
    ? contentActionAllowed : metadataActionAllowed;

  return <div className="flex min-w-0 flex-none flex-col overflow-visible md:min-h-0 md:flex-1 md:overflow-hidden"
    data-testid="graph-review-comparison">
    {reviewPending ? <div role={loadError ? 'alert' : 'status'} className="flex items-center justify-between gap-3 border-b bg-muted/40 px-4 py-2.5 text-sm">
      <span>{showError ?? t('graph.refreshing')}</span>
      {!loading && <Button type="button" variant="outline" size="sm" onClick={refresh}><RefreshCw className="size-4" aria-hidden="true" />{t('retry')}</Button>}
    </div> : null}
    <div className="flex min-h-48 flex-none flex-col overflow-visible md:min-h-0 md:flex-1 md:overflow-y-auto"
      data-testid="graph-review-body">
      <div className="border-b px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">{isBatch ? t('graph.allChanges') : t('agentProposal')}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('graph.selectionCount', { count: session.selectedProposalIds.length })}</p>
          </div>
          <Badge variant="outline" className={clean
            ? 'border-emerald-500/35 text-emerald-700 dark:text-emerald-200'
            : 'border-amber-500/40 text-amber-800 dark:text-amber-200'}>{t(statusKey(status))}</Badge>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {allIntent ? <Button ref={thisChangeButtonRef} type="button" variant="outline" size="sm" disabled={actionBusy || Boolean(actionIdentity)}
            onClick={() => { selectionFocusRequestedRef.current = true; changeSelection({ kind: 'operation', operationId }); }}>{t('graph.thisChange')}</Button> : null}
          {!allIntent ? <Button ref={reviewAllButtonRef} type="button" variant="outline" size="sm" disabled={actionBusy || Boolean(actionIdentity)}
            onClick={() => { selectionFocusRequestedRef.current = true; changeSelection({ kind: 'all' }); }}>{t('graph.reviewAll')}</Button> : null}
          {!allIntent && frozenAllIds ? <Button type="button" variant="outline" size="sm" disabled={actionBusy || Boolean(actionIdentity)}
            onClick={() => { selectionFocusRequestedRef.current = true;
              changeSelection({ kind: 'proposals', proposalIds: [...frozenAllIds] }, true); }}>
            {t('graph.returnFrozenAll', { count: frozenAllIds.length })}
          </Button> : null}
        </div>
      </div>
      <div className="space-y-4 p-4 sm:p-5">
        {session.capability.write && !session.context ? <Alert className="rounded-lg border-amber-500/35 bg-amber-500/[0.06]">
          <AlertTriangle aria-hidden="true" className="text-amber-700 dark:text-amber-300" />
          <AlertTitle>{t('graph.contextUnavailable')}</AlertTitle>
          <AlertDescription>{t('graph.contextUnavailableDescription')}</AlertDescription>
        </Alert> : null}
        {session.capability.write && session.context?.reasonCode ? <Alert className="rounded-lg border-amber-500/35 bg-amber-500/[0.06]">
          <AlertTriangle aria-hidden="true" className="text-amber-700 dark:text-amber-300" />
          <AlertTitle>{t('graph.contextBlocked')}</AlertTitle>
          <AlertDescription>{reviewReason(session.context.reasonCode)}</AlertDescription>
        </Alert> : null}
        {session.context ? <GraphContext context={session.context}
          inspectParent={(proposalId) => changeSelection({ kind: 'proposals', proposalIds: [proposalId] })}
          inspectProposal={(proposalId) => changeSelection({ kind: 'proposals', proposalIds: [proposalId] })}
          inspectAlternative={(proposalId) => changeSelection({ kind: 'proposals', proposalIds: [proposalId] })}
          disabled={Boolean(actionIdentity) || actionBusy} /> : null}
        {transformBusy ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />{t('graph.transform.checking')}
        </p> : null}
        {transformError ? <Alert variant="destructive" className="rounded-lg" data-testid="graph-review-transform-error">
          <ShieldAlert aria-hidden="true" /><AlertTitle>{t('graph.transform.failed')}</AlertTitle>
          <AlertDescription className="space-y-2"><p>{transformError instanceof ProposalReviewClientError
            ? transformError.code.startsWith('PROPOSAL_') ? t(reasonKey(transformError.code)) : t('graph.transportError')
            : transformError.message}</p>
            {transformError instanceof ProposalReviewClientError ? <GraphDiagnosis diagnosis={transformError.diagnosis} /> : null}
          </AlertDescription>
        </Alert> : null}
        {transformPreview && transformPreview.sessionKey === key && !reviewPending
          ? <GraphTransformPreview preview={transformPreview.preview} busy={!reviewActionAllowed}
            focusRef={transformPreviewFocusRef} onCancel={() => {
              cancelReturnFocusRef.current = transformReturnFocusRef.current;
              setTransformPreview(null);
            }} onConfirm={confirmTransform} /> : null}
        {provenNoEffect ? <Alert className="rounded-lg border-emerald-500/35 bg-emerald-500/[0.055]" data-testid="graph-review-no-effect">
          <Check aria-hidden="true" className="text-emerald-700 dark:text-emerald-300" />
          <AlertTitle>{t(statusKey(status))}</AlertTitle>
          <AlertDescription>{t(`graph.noEffect.${status}`)}</AlertDescription>
        </Alert> : !clean ? <Alert className="rounded-lg border-amber-500/35 bg-amber-500/[0.06]" data-testid="graph-review-blocked">
          <AlertTriangle aria-hidden="true" className="text-amber-700 dark:text-amber-300" />
          <AlertTitle>{t(statusKey(status))}</AlertTitle>
          <AlertDescription>{reviewReason(session.reasonCode)}</AlertDescription>
        </Alert> : null}
        {(available || provenNoEffect) && displayCompare ? <>
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold"><FileDiff className="size-4" aria-hidden="true" />{t('tabs.changes')}</h3>
            <div className="flex gap-1.5">
              <Badge variant="outline" className="border-emerald-500/30 text-emerald-700 dark:text-emerald-200">+{displayCompare.summary.additions}</Badge>
              <Badge variant="outline" className="border-destructive/30 text-destructive">−{displayCompare.summary.deletions}</Badge>
            </div>
          </div>
          <GraphHunks hunks={displayCompare.hunks} />
          {displayCompare.page.hasMore || compareError ? <div>
            {compareError ? <p role="alert" className="mb-2 text-xs text-destructive">{compareError}</p> : null}
            <Button type="button" variant="outline" size="sm" disabled={compareBusy || reviewPending} onClick={() => { void loadMore(); }}>
              {compareBusy ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <FileDiff className="size-4" aria-hidden="true" />}
              {t('loadMoreHunks')}
            </Button>
          </div> : null}
        </> : clean ? <Alert className="rounded-lg border-amber-500/35 bg-amber-500/[0.06]">
          <AlertTriangle aria-hidden="true" className="text-amber-700 dark:text-amber-300" />
          <AlertTitle>{t('graph.compareUnavailable')}</AlertTitle>
          <AlertDescription>{t(reasonKey(displayCompare?.diagnosis.reasonCode ?? session.reasonCode))}</AlertDescription>
        </Alert> : null}
        <GraphDiagnosis diagnosis={session.diagnosis} session={session} checkedAt={actionIdentity ? statusCheckedAt : null} />
      </div>
    </div>
    <div data-testid="graph-review-footer" className="min-w-0 shrink-0 space-y-3 border-t bg-muted/15 px-4 py-3 sm:px-5 [&_button]:h-auto [&_button]:min-h-8 [&_button]:min-w-0 [&_button]:max-w-full [&_button]:break-words [&_button]:whitespace-normal [&_button]:px-3 [&_button]:py-2 [&_button]:text-center [&_button]:leading-tight">
      {actionIdentity ? <Alert className="rounded-lg border-amber-500/35 bg-amber-500/[0.06]" data-testid="graph-review-pending-action">
        <AlertTriangle aria-hidden="true" className="text-amber-700 dark:text-amber-300" />
        <AlertTitle>{actionBusy ? t('graph.durability.submitting')
          : receiptPhase ? t(`graph.durability.${receiptPhase}`) : t('graph.durability.unconfirmed')}</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-2">
          {statusCheckedAt !== null ? <span className="text-xs">{t('graph.durability.checkedAt', {
            time: new Date(statusCheckedAt).toLocaleString(),
          })}</span> : null}
          <Button type="button" variant="outline" size="sm" disabled={statusBusy}
            onClick={() => setStatusReload((value) => value + 1)}>{t('graph.checkStatus')}</Button>
          {actionRequest && (actionError || statusError) ? <Button type="button" variant="outline" size="sm" disabled={actionBusy}
            onClick={() => { void execute(actionRequest); }}>{t('graph.retrySameAction')}</Button> : null}
          {statusError ? <span role="alert">{statusError}</span> : null}
        </AlertDescription>
      </Alert> : null}
      {!session.capability.write ? <p role="status" className="text-xs text-muted-foreground">{t('graph.readOnly')}</p> : null}
      {actionError ? <Alert variant="destructive" className="rounded-lg" data-testid="graph-review-action-error">
        <AlertTitle>{t(actionIdentity ? 'graph.actionUncertainTitle' : 'graph.actionFailed')}</AlertTitle><AlertDescription className="space-y-2">
          <p>{actionError instanceof ProposalReviewClientError
            ? actionError.code.startsWith('PROPOSAL_') ? t(reasonKey(actionError.code)) : t('graph.transportError')
            : actionError.message}</p>
          {actionError instanceof ProposalReviewClientError ? <GraphDiagnosis diagnosis={actionError.diagnosis} /> : null}
          {!actionIdentity ? <Button type="button" variant="outline" size="sm" disabled={actionBusy} onClick={refresh}>{t('refreshTimeline')}</Button> : null}
        </AlertDescription>
      </Alert> : null}
      {pending && !actionRequest ? <div ref={confirmationRef} tabIndex={-1} role="group" aria-labelledby="graph-review-confirmation-title"
        className="rounded-lg border border-violet-500/30 bg-violet-500/[0.045] p-3" data-testid="graph-review-confirmation">
        <p id="graph-review-confirmation-title" className="text-sm font-semibold">{t(`graph.confirm.${pending.action}`)}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t('graph.confirmExact', { count: session.selectedProposalIds.length })}</p>
        {session.context && pending.action === 'accept' ? <p className="mt-1 text-xs text-muted-foreground">
          {t('graph.confirmConsequences', { prerequisites: session.context.dependencyProposalIds.length,
            alternatives: session.context.closingAlternativeProposalIds.length })}
        </p> : null}
        {pending.action === 'branchReject' ? <p className="mt-1 text-xs text-muted-foreground">
          {t('graph.confirmBranch', { count: Math.max(0, pending.prepared.fence.closure.length - 1) })}
        </p> : null}
        <div className="mt-3 flex min-w-0 flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => {
            cancelReturnFocusRef.current = pendingReturnFocusRef.current;
            setPending(null);
          }}>{t('actions.cancel')}</Button>
          <Button type="button" size="sm" disabled={!pendingAllowed || pending.sessionKey !== key} onClick={confirm}>
            <Check className="size-4" aria-hidden="true" />{t('graph.confirmAction')}
          </Button>
        </div>
      </div> : null}
      <div className="flex min-w-0 flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button ref={continueButtonRef} type="button" variant="ghost" size="sm" disabled={actionBusy} onClick={onContinue}>{t('actions.continue')}</Button>
        <div className="flex min-w-0 flex-wrap justify-end gap-2">
          {preparedActions.reject ? <Button type="button" variant="outline" size="sm" disabled={!metadataActionAllowed}
            onClick={(event) => { pendingReturnFocusRef.current = event.currentTarget;
              confirmationFocusRequestedRef.current = true;
              setPending({ action: 'reject', prepared: preparedActions.reject!, sessionKey: key }); }}>
            <X className="size-4" aria-hidden="true" />{t('actions.reject')}
          </Button> : null}
          {preparedActions.branchReject ? <Button type="button" variant="outline" size="sm" disabled={!metadataActionAllowed}
            onClick={(event) => { pendingReturnFocusRef.current = event.currentTarget;
              confirmationFocusRequestedRef.current = true;
              setPending({ action: 'branchReject', prepared: preparedActions.branchReject!, sessionKey: key }); }}>
            <X className="size-4" aria-hidden="true" />{t('graph.rejectBranch')}
          </Button> : null}
          {preparedActions.completeSatisfied ? <Button type="button" variant="outline" size="sm" disabled={!contentActionAllowed}
            onClick={(event) => { pendingReturnFocusRef.current = event.currentTarget;
              confirmationFocusRequestedRef.current = true;
              setPending({ action: 'completeSatisfied', prepared: preparedActions.completeSatisfied!, sessionKey: key }); }}>
            <Check className="size-4" aria-hidden="true" />{t('graph.completeSatisfied')}
          </Button> : null}
          {session.capability.write && session.selectedProposalIds.length === 1 && !allIntent ? <>
            <Button type="button" variant="outline" size="sm" disabled={!transformActionAllowed}
              onClick={(event) => { transformReturnFocusRef.current = event.currentTarget;
                transformFocusRequestedRef.current = true; void startTransform('detach'); }}>{t('graph.transform.detach.start')}</Button>
            <Button type="button" variant="outline" size="sm" disabled={!transformActionAllowed}
              onClick={(event) => { transformReturnFocusRef.current = event.currentTarget;
                transformFocusRequestedRef.current = true; void startTransform('replace'); }}>{t('graph.transform.replace.start')}</Button>
          </> : null}
          {preparedActions.accept && available ? <Button type="button" size="sm"
            className="bg-violet-600 text-white hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-600"
            disabled={!contentActionAllowed} onClick={(event) => { pendingReturnFocusRef.current = event.currentTarget;
              confirmationFocusRequestedRef.current = true;
              setPending({ action: 'accept', prepared: preparedActions.accept!, sessionKey: key }); }}>
            <Check className="size-4" aria-hidden="true" />{isBatch ? t('graph.acceptAll') : t('actions.accept')}
          </Button> : null}
        </div>
      </div>
    </div>
  </div>;
}
