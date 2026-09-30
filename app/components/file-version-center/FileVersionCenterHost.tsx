'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, FileClock, FileQuestion, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  type FileVersionMutation,
} from '@/app/lib/file-version-center/action-client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FileVersionCenterClientError, resolveFileVersionCenterWhenReady } from '@/app/lib/file-version-center/client';
import { FILE_VERSION_CENTER_CONTRACT_VERSION } from '@/app/lib/file-version-center/contracts/v1';
import type {
  FileVersionCenterRequestV1,
  FileVersionTimelineEntryV1,
  FileVersionTimelineResponseV1,
} from '@/app/lib/file-version-center/contracts/v1';
import { loadFileVersionTimelinePage } from '@/app/lib/file-version-center/timeline-client';
import { ProposalReviewClientError, readProposalReviewSummary } from '@/app/lib/file-version-center/proposal-review-client';
import type { ProposalReviewSummaryResponseV1 } from '@/app/lib/file-version-center/contracts/proposal-review-summary-v1';
import {
  mergeFileVersionTimelinePage,
  reconcileFileVersionTimelineSelection,
} from '@/app/lib/file-version-center/timeline-state';
import {
  claimFileChangeReviewAcknowledgement,
  closeVersionCenter,
  releaseFileChangeReviewAcknowledgement,
  selectVersionCenterEntry,
  syncVersionCenterFromLocation,
  useFileVersionCenterStore,
} from '@/app/store/file-version-center-store';
import { updateNotification } from '@/app/components/notifications/notification-actions';

import { getFileWatcherClient, type FileEvent } from '@/app/lib/file-watcher/client';
import { authClient } from '@/app/lib/auth-client';
import { openedDocumentAuthScope, subscribeOpenedDocumentAuthInvalidation } from '@/app/lib/collaboration/opened-document-registry';
import { readOpenCollaborationReviewReadiness, subscribeOpenCollaborationReviewReadiness } from '@/app/lib/collaboration/client';
import { useEditorStore } from '@/app/store/editor-store';
import { useFileStore } from '@/app/store/file-store';
import { useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import { invalidateReviewQueries } from '@/app/lib/queries/review-queries';
import { FileVersionLoadingSkeleton } from './FileVersionLoadingSkeleton';
import { FileVersionComparison } from './FileVersionComparison';
import { FileVersionTimeline } from './FileVersionTimeline';
import { WorkspaceOperationReviewPanel } from './WorkspaceOperationReviewPanel';
import type { GraphReviewCardStatus } from './GraphReviewComparison';
import { closeWorkspaceOperationReview, useWorkspaceOperationReviewStore } from '@/app/store/workspace-operation-review-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { useWorkspaceOperationReviewNavigation } from './useWorkspaceOperationReviewNavigation';

type MobileReviewPane = 'timeline' | 'comparison';

function mobileReviewPaneKey(request: FileVersionCenterRequestV1 | null): string | null {
  return request ? JSON.stringify([request.target, request.selectedEntry ?? null]) : null;
}

function subscribeFileVersionAuth(listener: () => void): () => void {
  // Initial session hydration is not a revocation, but it still changes the
  // partition of a review opened before the authentication atom resolves.
  const unsubscribeSession = authClient.$store.atoms.session.listen(listener);
  const unsubscribeInvalidation = subscribeOpenedDocumentAuthInvalidation(listener);
  return () => { unsubscribeSession(); unsubscribeInvalidation(); };
}

export function FileVersionCenterHost() {
  const t = useTranslations('fileVersionCenter');
  const router = useRouter();
  const request = useFileVersionCenterStore((state) => state.request);
  const workspaceReviewRequest = useWorkspaceOperationReviewStore((state) => state.request);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const authScope = useSyncExternalStore(subscribeFileVersionAuth, openedDocumentAuthScope, () => null);
  useWorkspaceOperationReviewNavigation(authScope);
  const workspaceReviewAuthScopeRef = useRef(authScope);
  const targetIdentity = request ? JSON.stringify([authScope, request.target]) : null;
  const [resolvedTimeline, setResolvedTimeline] = useState<{ identity: string;
    requestTarget: FileVersionCenterRequestV1['target']; value: FileVersionTimelineResponseV1 } | null>(null);
  const [failure, setFailure] = useState<{ identity: string; message: string } | null>(null);
  const timeline = resolvedTimeline?.identity === targetIdentity ? resolvedTimeline.value : null;
  const timelineAvailable = timeline !== null;
  const error = failure?.identity === targetIdentity ? failure.message : null;
  const currentEntry = timeline?.entries.find((entry) => entry.kind === 'current');
  const reviewIdentity = JSON.stringify([targetIdentity, timeline?.document.documentId,
    currentEntry?.kind === 'current' ? currentEntry.revisionId : null,
    currentEntry?.kind === 'current' ? currentEntry.sha256 : null,
    currentEntry?.kind === 'current' ? currentEntry.stateVectorHash : null]);
  const reviewScopeIdentity = authScope && timeline ? JSON.stringify([authScope,
    timeline.document.workspaceId, timeline.document.lineageId, timeline.document.documentId]) : null;
  const [reviewCard, setReviewCard] = useState<{ identity: string; request: FileVersionCenterRequestV1;
    value: GraphReviewCardStatus } | null>(null);
  const [reviewSummary, setReviewSummary] = useState<{ timeline: FileVersionTimelineResponseV1; identity: string;
    scopeIdentity: string;
    reload: number; value: ProposalReviewSummaryResponseV1 } | null>(null);
  const [reviewSummaryError, setReviewSummaryError] = useState<{ timeline: FileVersionTimelineResponseV1;
    reload: number; message: string } | null>(null);
  const [reviewSummaryReload, setReviewSummaryReload] = useState(0);
  const summaryRaceRetryRef = useRef<string | null>(null);
  const [externalRefresh, setExternalRefresh] = useState(false);
  const scheduleExternalRefreshRef = useRef<(() => void) | null>(null);
  const [invalidatedTarget, setInvalidatedTarget] = useState<string | null>(null);
  const invalidationRevisionRef = useRef(0);
  const editorPath = useEditorStore((state) => state.activePath);
  const editorDirty = useEditorStore((state) => state.isDirty);
  const editorWorkspaceId = useFileStore((state) => state.currentFileWorkspaceId);
  const localCollaborationPending = useSyncExternalStore(subscribeOpenCollaborationReviewReadiness,
    () => readOpenCollaborationReviewReadiness({ workspaceId: timeline?.document.workspaceId,
      documentId: timeline?.document.documentId, authScope }) === 'pending', () => false);
  const unsavedReviewDocument = localCollaborationPending || Boolean(timeline && editorDirty
    && editorPath === timeline.document.path && editorWorkspaceId === timeline.document.workspaceId);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const paginationAbortRef = useRef<AbortController | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const mobileSelectionFocusRef = useRef<HTMLElement | null>(null);
  const mobileDetailHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const mobileTimelinePaneRef = useRef<HTMLDivElement | null>(null);
  const mobilePaneKey = mobileReviewPaneKey(request);
  const [mobilePaneOverride, setMobilePaneOverride] = useState<{ key: string; pane: MobileReviewPane } | null>(null);
  const mobilePane = mobilePaneOverride?.key === mobilePaneKey
    ? mobilePaneOverride.pane
    : request?.selectedEntry ? 'comparison' : 'timeline';
  const purgeResolvedReview = useCallback((identity: string) => {
    setResolvedTimeline((current) => current?.identity === identity ? null : current);
    setReviewCard(null);
    setReviewSummary(null);
    setReviewSummaryError(null);
  }, [setResolvedTimeline, setReviewCard, setReviewSummary, setReviewSummaryError]);

  const load = useCallback(async (
    activeRequest: FileVersionCenterRequestV1,
    signal?: AbortSignal,
    options?: { preserveTimeline?: boolean },
  ) => {
    const generation = ++requestGenerationRef.current;
    const identity = JSON.stringify([authScope, activeRequest.target]);
    const invalidationRevision = invalidationRevisionRef.current;
    const isCurrent = () => generation === requestGenerationRef.current && !signal?.aborted
      && openedDocumentAuthScope() === authScope;
    paginationAbortRef.current?.abort();
    paginationAbortRef.current = null;
    setLoading(true);
    setFailure(null);
    setLoadMoreError(null);
    setLoadingMore(false);
    const resolvingRequest = activeRequest;
    try {
      if (options?.preserveTimeline) await invalidateReviewQueries(activeRequest.target.workspaceId);
      if (!isCurrent()) return;
      for (;;) {
        try {
          const next = await resolveFileVersionCenterWhenReady(resolvingRequest, signal);
          if (!isCurrent()) return;
          if (next.document.workspaceId !== resolvingRequest.target.workspaceId) {
            throw new Error('The resolved document belongs to another workspace.');
          }
          setResolvedTimeline({ identity, requestTarget: activeRequest.target, value: next });
          if (invalidationRevision === invalidationRevisionRef.current) setInvalidatedTarget(null);
          return;
        } catch (loadError) {
          if (!isCurrent()
            || (loadError instanceof DOMException && loadError.name === 'AbortError')) return;
          if (loadError instanceof FileVersionCenterClientError
            && loadError.code === 'FVRC_STALE_SELECTION') {
            window.dispatchEvent(new CustomEvent('notification_summary_updated'));
            // An exact historical reference must never silently become another
            // proposal. Terminal graph entries are readable by their exact ID;
            // truly missing entries stay a visible error instead of selecting latest.
          }
          if (loadError instanceof FileVersionCenterClientError
            && (loadError.status === 401 || loadError.status === 403 || loadError.status === 404
              || loadError.code === 'FVRC_ACCESS_DENIED' || loadError.code === 'FVRC_NOT_FOUND')) {
            // A previously resolved document is no longer authorized or
            // addressable. Never retain its private timeline under an error.
            purgeResolvedReview(identity);
            // load() already aborted and cleared any page request before this resolve.
          }
          setFailure({ identity, message: loadError instanceof Error ? loadError.message : t('loadFailed') });
          return;
        }
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [authScope, purgeResolvedReview, t]);

  const requestTarget = request?.target;
  const requestSource = request?.source;
  const resolutionRequest = useMemo<FileVersionCenterRequestV1 | null>(() => {
    if (!requestTarget || !requestSource) return null;
    const active = useFileVersionCenterStore.getState().request;
    return active?.target === requestTarget && active.source === requestSource ? active : null;
  }, [requestSource, requestTarget]);

  useEffect(() => {
    try {
      syncVersionCenterFromLocation(window.location.search);
    } catch {
      closeVersionCenter();
    }
    const onPopState = () => {
      try {
        syncVersionCenterFromLocation(window.location.search);
      } catch {
        closeVersionCenter();
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!resolutionRequest) {
      requestGenerationRef.current += 1;
      paginationAbortRef.current?.abort();
      return;
    }
    if (!returnFocusRef.current && document.activeElement instanceof HTMLElement) {
      returnFocusRef.current = document.activeElement;
    }
    const controller = new AbortController();
    const begin = window.setTimeout(() => { void load(resolutionRequest, controller.signal); }, 0);
    return () => {
      window.clearTimeout(begin);
      requestGenerationRef.current += 1;
      controller.abort();
      paginationAbortRef.current?.abort();
    };
  }, [load, resolutionRequest]);

  const observedWorkspaceId = timeline?.document.workspaceId;
  const observedPath = timeline?.document.path;
  useEffect(() => {
    if (!targetIdentity || !observedWorkspaceId || !observedPath) return;
    const markChanged = (refreshAfterChange = false) => {
      invalidationRevisionRef.current += 1;
      setInvalidatedTarget(targetIdentity);
      if (refreshAfterChange) {
        const editor = useEditorStore.getState();
        if (!(editor.isDirty && editor.activePath === observedPath
          && useFileStore.getState().currentFileWorkspaceId === observedWorkspaceId)) {
          scheduleExternalRefreshRef.current?.();
        }
      }
    };
    const fileChanged = useFileStore.subscribe((state, previous) => {
      if (state.currentFileWorkspaceId === observedWorkspaceId && state.currentFile?.path === observedPath
        && previous.currentFileWorkspaceId === observedWorkspaceId && previous.currentFile?.path === observedPath
        && state.currentFile.content !== previous.currentFile.content) markChanged(true);
    });
    const draftChanged = useEditorStore.subscribe((state, previous) => {
      if (useFileStore.getState().currentFileWorkspaceId === observedWorkspaceId
        && state.activePath === observedPath && previous.activePath === observedPath
        && state.draft !== previous.draft) markChanged();
    });
    const watcher = getFileWatcherClient();
    const fileEvent = (event: Event) => {
      const detail = (event as CustomEvent<FileEvent>).detail;
      if (detail && (!detail.workspaceId || detail.workspaceId === observedWorkspaceId)
        && (detail.relativePath === observedPath || detail.mutation?.oldPath === observedPath)) markChanged(true);
    };
    watcher.addEventListener('filechange', fileEvent);
    return () => {
      fileChanged();
      draftChanged();
      watcher.removeEventListener('filechange', fileEvent);
    };
  }, [observedPath, observedWorkspaceId, targetIdentity]);

  const selection = useMemo(() => request && timeline
    ? reconcileFileVersionTimelineSelection({ request, timeline })
    : null, [request, timeline]);
  const onGraphReviewStatus = useCallback((status: GraphReviewCardStatus | null) => {
    if (useFileVersionCenterStore.getState().request !== request) return;
    setReviewCard(status && request ? { identity: reviewIdentity, request, value: status } : null);
  }, [request, reviewIdentity]);
  const visibleReviewCard = !loading && !externalRefresh && !error && invalidatedTarget !== targetIdentity && !unsavedReviewDocument
    && reviewCard?.identity === reviewIdentity && reviewCard.request === request
    && selection?.entry?.kind === 'agent_operation'
    && selection.entry.operationId === reviewCard.value.operationId ? reviewCard.value : null;
  const visibleReviewSummary = !loading && !externalRefresh && !error && invalidatedTarget !== targetIdentity && !unsavedReviewDocument
    && reviewSummary?.timeline === timeline && reviewSummary.identity === reviewIdentity
    && reviewSummary.reload === reviewSummaryReload ? reviewSummary.value : null;
  // Keep only the non-sensitive row layout through a same-document refresh.
  // Evaluation, status, and actions still require the fresh visible summary.
  const reviewGroupRoots = !visibleReviewSummary && !error && reviewScopeIdentity
    && reviewSummary?.scopeIdentity === reviewScopeIdentity
    ? new Map(reviewSummary.value.items.flatMap((item) => item.mode === 'graph' && item.proposal
      ? [[item.operationId, item.proposal.rootProposalId] as const] : [])) : null;
  const visibleReviewSummaryError = !authScope || error || invalidatedTarget === targetIdentity && !externalRefresh
    || unsavedReviewDocument ? t('graph.summaryUnavailable')
    : reviewSummaryError?.timeline === timeline && reviewSummaryError.reload === reviewSummaryReload
      ? reviewSummaryError.message : null;

  useEffect(() => {
    if (!timeline || !requestTarget || !authScope || !targetIdentity) return;
    const operationIds = timeline.entries
      .filter((entry): entry is Extract<FileVersionTimelineEntryV1, { kind: 'agent_operation' }> => entry.kind === 'agent_operation')
      .map((entry) => entry.operationId);
    if (!operationIds.length) return;
    const controller = new AbortController();
    const sourceGeneration = requestGenerationRef.current;
    const retryIncident = JSON.stringify([targetIdentity, reviewSummaryReload]);
    const active = () => !controller.signal.aborted && openedDocumentAuthScope() === authScope;
    Promise.resolve().then(() => { if (active()) setReviewSummaryError(null); });
    const read = async (): Promise<ProposalReviewSummaryResponseV1> => {
      const responses: ProposalReviewSummaryResponseV1[] = [];
      for (let index = 0; index < operationIds.length; index += 32) {
        responses.push(await readProposalReviewSummary({ contractVersion: 1, target: requestTarget,
          operationIds: operationIds.slice(index, index + 32) }, controller.signal));
      }
      const first = responses[0]!;
      const graphAnchor = responses.find((response) => response.current && response.graphRevision !== null);
      const expectedDocumentId = timeline.document.documentId ?? null;
      const current = timeline.entries.find((entry) => entry.kind === 'current');
      if (first.target.workspaceId !== timeline.document.workspaceId || first.target.lineageId !== timeline.document.lineageId
        || first.target.documentId !== expectedDocumentId
        || graphAnchor && current?.kind !== 'current'
        || graphAnchor?.current && current?.kind === 'current'
          && (graphAnchor.current.contentHash !== current.sha256
            || current.stateVectorHash && graphAnchor.current.stateVectorHash !== current.stateVectorHash)
        || responses.some((response) => response.target.workspaceId !== first.target.workspaceId
          || response.target.lineageId !== first.target.lineageId || response.target.documentId !== first.target.documentId
          || response.current && graphAnchor?.current
            && JSON.stringify(response.current) !== JSON.stringify(graphAnchor.current)
          || response.graphRevision !== null && graphAnchor
            && response.graphRevision !== graphAnchor.graphRevision)) {
        throw new Error(t('graph.summaryUnavailable'));
      }
      return { ...first, current: graphAnchor?.current ?? null, graphRevision: graphAnchor?.graphRevision ?? null,
        items: responses.flatMap((response) => response.items) };
    };
    void read().then((value) => {
      if (active()) {
        if (summaryRaceRetryRef.current === retryIncident) summaryRaceRetryRef.current = null;
        setReviewSummary({ timeline, identity: reviewIdentity, scopeIdentity: reviewScopeIdentity!,
          reload: reviewSummaryReload, value });
      }
    }).catch((summaryError: unknown) => {
      if (active() && !(summaryError instanceof DOMException && summaryError.name === 'AbortError')) {
        if (summaryError instanceof ProposalReviewClientError
          && (summaryError.status === 401 || summaryError.status === 403 || summaryError.status === 404
            || summaryError.code === 'PROPOSAL_ACCESS_DENIED' || summaryError.code === 'FVRC_ACCESS_DENIED'
            || summaryError.code === 'FVRC_NOT_FOUND')) {
          const latestRequest = useFileVersionCenterStore.getState().request;
          if (latestRequest && JSON.stringify([authScope, latestRequest.target]) === targetIdentity) {
            requestGenerationRef.current += 1;
            paginationAbortRef.current?.abort();
            paginationAbortRef.current = null;
            setLoading(false);
            purgeResolvedReview(targetIdentity);
            setFailure({ identity: targetIdentity, message: summaryError.code === 'PROPOSAL_ACCESS_DENIED'
              ? t('graph.reason.PROPOSAL_ACCESS_DENIED') : t('graph.summaryUnavailable') });
          }
          return;
        }
        // A concurrent current/graph mutation can race the timeline proof.
        // Re-resolve once, then let the new timeline initiate its own summary
        // read. Do not retry transport, authorization, schema or rate errors.
        if (summaryError instanceof ProposalReviewClientError
          && (summaryError.code === 'PROPOSAL_CURRENT_CHANGED' || summaryError.code === 'PROPOSAL_GRAPH_CHANGED')
          && requestGenerationRef.current === sourceGeneration
          && summaryRaceRetryRef.current !== retryIncident) {
          const latestRequest = useFileVersionCenterStore.getState().request;
          if (latestRequest && JSON.stringify([authScope, latestRequest.target]) === targetIdentity) {
            summaryRaceRetryRef.current = retryIncident;
            void load(latestRequest, undefined, { preserveTimeline: true });
            return;
          }
        }
        setReviewSummaryError({ timeline, reload: reviewSummaryReload, message: t('graph.summaryUnavailable') });
      }
    });
    return () => controller.abort();
  }, [authScope, load, purgeResolvedReview, requestTarget, reviewIdentity, reviewScopeIdentity,
    reviewSummaryReload, t, targetIdentity, timeline]);

  useEffect(() => {
    if (
      request?.target.kind !== 'lineage'
      || resolvedTimeline?.requestTarget !== request.target
      || request.selectedEntry?.kind !== 'agent_operation'
      || timeline?.document.workspaceId !== request.target.workspaceId
      || timeline.document.lineageId !== request.target.lineageId
      || selection?.state !== 'selected'
      || selection.entry?.kind !== 'agent_operation'
      || selection.entry.operationId !== request.selectedEntry.id
    ) return;
    const acknowledgement = claimFileChangeReviewAcknowledgement({
      request,
      workspaceId: timeline.document.workspaceId,
      lineageId: timeline.document.lineageId,
      operationId: selection.entry.operationId,
      branchRootProposalId: visibleReviewCard?.branchContext?.rootProposalId,
    });
    if (!acknowledgement) return;
    void updateNotification({
      action: 'mark_item_read',
      itemId: acknowledgement.itemId,
      workspaceId: acknowledgement.workspaceId,
      ...(acknowledgement.expectedRevision ? { expectedRevision: acknowledgement.expectedRevision } : {}),
    }).catch(() => {
      releaseFileChangeReviewAcknowledgement(acknowledgement.generation);
    });
  }, [request, resolvedTimeline, selection, timeline, visibleReviewCard]);

  const selectEntry = useCallback((entry: FileVersionTimelineEntryV1) => {
    if (document.activeElement instanceof HTMLElement) mobileSelectionFocusRef.current = document.activeElement;
    const selectedEntry: FileVersionCenterRequestV1['selectedEntry'] = entry.kind === 'current'
      ? undefined : { kind: entry.kind, id: entry.id };
    const nextRequest = request ? { ...request, selectedEntry } : null;
    const nextKey = mobileReviewPaneKey(nextRequest);
    if (nextKey) setMobilePaneOverride({ key: nextKey, pane: entry.kind === 'current' ? 'timeline' : 'comparison' });
    selectVersionCenterEntry(selectedEntry ?? null);
  }, [request]);

  const showMobileTimeline = useCallback(() => {
    if (mobilePaneKey) setMobilePaneOverride({ key: mobilePaneKey, pane: 'timeline' });
  }, [mobilePaneKey]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function' || !window.matchMedia('(max-width: 767px)').matches) return;
    const frame = window.requestAnimationFrame(() => {
      if (mobilePane === 'comparison') mobileDetailHeadingRef.current?.focus();
      else {
        const returnFocus = mobileSelectionFocusRef.current?.isConnected
          ? mobileSelectionFocusRef.current
          : mobileTimelinePaneRef.current?.querySelector<HTMLElement>('button[aria-pressed="true"]');
        returnFocus?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mobilePane, selection?.key]);

  const loadMore = useCallback(async () => {
    const activeRequest = request;
    const activeTimeline = timeline;
    const cursor = activeTimeline?.page.nextCursor;
    if (!activeRequest || !activeTimeline?.page.hasMore || !cursor || loadingMore || paginationAbortRef.current) return;
    const generation = requestGenerationRef.current;
    const controller = new AbortController();
    paginationAbortRef.current = controller;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await loadFileVersionTimelinePage({
        contractVersion: FILE_VERSION_CENTER_CONTRACT_VERSION,
        target: activeRequest.target,
        cursor,
        limit: 25,
      }, controller.signal);
      if (generation !== requestGenerationRef.current || controller.signal.aborted
        || openedDocumentAuthScope() !== authScope) return;
      const merged = mergeFileVersionTimelinePage(activeTimeline, page);
      const identity = JSON.stringify([authScope, activeRequest.target]);
      setResolvedTimeline((current) => current?.identity === identity ? { ...current, value: merged } : current);
    } catch (pageError) {
      if (generation !== requestGenerationRef.current || controller.signal.aborted
        || (pageError instanceof DOMException && pageError.name === 'AbortError')) return;
      setLoadMoreError(pageError instanceof Error ? pageError.message : t('loadMoreFailed'));
    } finally {
      if (paginationAbortRef.current === controller) paginationAbortRef.current = null;
      if (generation === requestGenerationRef.current) setLoadingMore(false);
    }
  }, [authScope, loadingMore, request, setResolvedTimeline, t, timeline]);

  const close = useCallback(() => {
    if (request) closeVersionCenter();
    else closeWorkspaceOperationReview();
  }, [request]);

  useEffect(() => {
    if (request && workspaceReviewRequest) closeWorkspaceOperationReview();
  }, [request, workspaceReviewRequest]);

  useEffect(() => {
    if (workspaceReviewRequest && workspaceReviewRequest.workspaceId !== activeWorkspaceId) {
      closeWorkspaceOperationReview();
    }
  }, [activeWorkspaceId, workspaceReviewRequest]);

  useEffect(() => {
    const previousScope = workspaceReviewAuthScopeRef.current;
    workspaceReviewAuthScopeRef.current = authScope;
    if (workspaceReviewRequest && previousScope && previousScope !== authScope) {
      closeWorkspaceOperationReview();
    }
  }, [authScope, workspaceReviewRequest]);
  const resolvedPath = timeline?.document.path;
  const targetLabel = resolvedPath ?? (request?.target.kind === 'path'
    ? request.target.pathHint
    : t('resolvingDocument'));
  const mobileDetailTitle = selection?.entry?.kind === 'agent_operation'
    ? t('agentProposal')
    : selection?.entry?.kind === 'revision'
      ? t('revisionNumber', { number: selection.entry.revisionNumber })
      : t('currentVersion');

  const invalidateTimeline = useCallback(async (action?: FileVersionMutation) => {
    if (!request || openedDocumentAuthScope() !== authScope) return;
    await invalidateReviewQueries(request.target.workspaceId);
    const activeRequest = useFileVersionCenterStore.getState().request;
    if (!activeRequest || JSON.stringify([authScope, activeRequest.target]) !== targetIdentity) return;
    if (action && activeRequest.selectedEntry?.kind === request.selectedEntry?.kind
      && activeRequest.selectedEntry?.id === request.selectedEntry?.id) selectVersionCenterEntry(null);
    const refreshedRequest = useFileVersionCenterStore.getState().request;
    if (refreshedRequest) await load(refreshedRequest, undefined, { preserveTimeline: true });
  }, [authScope, load, request, targetIdentity]);

  const refreshCurrentTarget = useCallback(async () => {
    if (!authScope || openedDocumentAuthScope() !== authScope) return;
    const activeRequest = useFileVersionCenterStore.getState().request;
    if (!activeRequest || JSON.stringify([authScope, activeRequest.target]) !== targetIdentity) return;
    await load(activeRequest, undefined, { preserveTimeline: true });
  }, [authScope, load, targetIdentity]);

  useEffect(() => {
    if (!targetIdentity || !timelineAvailable || !authScope) return;
    let disposed = false;
    let timer: number | null = null;
    let running = false;
    let trailing = false;
    const refresh = async () => {
      if (disposed) return;
      running = true;
      let passes = 0;
      try {
        do {
          trailing = false;
          await refreshCurrentTarget();
          passes += 1;
        } while (!disposed && trailing && passes < 2);
      } finally {
        running = false;
        if (!disposed) setExternalRefresh(false);
      }
    };
    const schedule = () => {
      if (disposed || document.visibilityState === 'hidden' || openedDocumentAuthScope() !== authScope) return;
      setExternalRefresh(true);
      if (running) { trailing = true; return; }
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; void refresh(); }, 150);
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') schedule(); };
    scheduleExternalRefreshRef.current = schedule;
    // There is no cross-client graph event stream; refresh on return to the tab
    // and on the existing file-change signal above, without polling.
    window.addEventListener('focus', schedule);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      if (scheduleExternalRefreshRef.current === schedule) scheduleExternalRefreshRef.current = null;
      window.removeEventListener('focus', schedule);
      document.removeEventListener('visibilitychange', onVisibility);
      setExternalRefresh(false);
    };
  }, [authScope, refreshCurrentTarget, targetIdentity, timelineAvailable]);

  const continueEditing = useCallback(() => {
    if (!timeline) return;
    closeVersionCenter({ syncLocation: false });
    router.push({ pathname: '/notebook', query: {
      workspaceId: timeline.document.workspaceId, path: timeline.document.path, chat: 'open',
    } });
  }, [router, timeline]);

  return (
    <Dialog open={Boolean(request || workspaceReviewRequest)} onOpenChange={(open) => { if (!open) close(); }}>
      {request ? (
        <DialogContent
          layout="viewport"
          className="transition-[opacity,transform]"
          data-testid="file-version-center"
          aria-busy={loading || loadingMore}
          onCloseAutoFocus={(event) => {
            const returnFocus = returnFocusRef.current;
            returnFocusRef.current = null;
            if (!returnFocus?.isConnected) return;
            event.preventDefault();
            returnFocus.focus();
          }}
        >
          <DialogHeader className="border-b px-4 py-3 pr-12 sm:px-6 sm:py-4 sm:pr-14">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/45 text-muted-foreground sm:size-9">
                <FileClock className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <DialogTitle>{t('title')}</DialogTitle>
                <DialogDescription className="mt-1 truncate" title={resolvedPath}>
                  {targetLabel}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          {error && timeline ? <div role="alert" className="flex items-center justify-between gap-3 border-b px-5 py-3 text-sm">
            <span>{error}</span>
            <Button variant="outline" size="sm" disabled={loading} onClick={() => { void invalidateTimeline(); }}>{t('retry')}</Button>
          </div> : null}
          <div className="flex min-h-0 flex-1 items-center justify-center">
            {!timeline && !error ? (
              <FileVersionLoadingSkeleton label={t('loading')} timeline />
            ) : error && !timeline ? (
              <div role="alert" className="m-6 max-w-md rounded-xl border bg-muted/25 p-5 text-center">
                <p className="text-sm font-medium">{t('loadFailed')}</p>
                <p className="mt-1 text-sm text-muted-foreground">{error}</p>
                <Button
                  className="mt-4"
                  variant="outline"
                  size="sm"
                  onClick={() => { if (request) void load(request); }}
                >
                  <RefreshCw className="size-4" aria-hidden="true" />
                  {t('retry')}
                </Button>
              </div>
            ) : timeline && !timeline.capabilities.history ? (
              <div data-testid="file-version-center-unavailable" className="flex max-w-md flex-col items-center p-6 text-center">
                <span className="flex size-10 items-center justify-center rounded-lg border bg-muted/35 text-muted-foreground">
                  <FileQuestion className="size-4" aria-hidden="true" />
                </span>
                <p className="mt-3 text-sm font-semibold">{t('historyUnavailable')}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {timeline.capabilities.reason === 'rollout_disabled'
                    ? t('historyDisabledDescription')
                    : t('historyUnavailableDescription')}
                </p>
              </div>
            ) : timeline && selection ? (
              <div
                data-testid="file-version-center-responsive-layout"
                data-mobile-pane={mobilePane}
                className="grid size-full min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]"
              >
                <div
                  ref={mobileTimelinePaneRef}
                  data-testid="file-version-center-mobile-timeline-pane"
                  className={cn('min-h-0 min-w-0 flex-col', mobilePane === 'timeline' ? 'flex' : 'hidden', 'md:flex')}
                >
                  <FileVersionTimeline
                    timeline={timeline}
                    selection={selection}
                    evaluatedReview={visibleReviewCard}
                    reviewSummary={visibleReviewSummary?.items ?? null}
                    reviewGroupRoots={reviewGroupRoots}
                    reviewSummaryError={visibleReviewSummaryError}
                    onRetryReviewSummary={() => setReviewSummaryReload((value) => value + 1)}
                    onSelect={selectEntry}
                    onLoadMore={() => { void loadMore(); }}
                    loadingMore={loadingMore}
                    loadMoreError={loadMoreError}
                  />
                </div>
                <div
                  data-testid="file-version-center-mobile-comparison-pane"
                  className={cn('min-h-0 min-w-0 flex-col bg-background', mobilePane === 'comparison' ? 'flex' : 'hidden', 'md:flex')}
                >
                  <div className="flex shrink-0 items-center gap-2 border-b bg-background/95 px-3 py-2.5 backdrop-blur-sm md:hidden">
                    <Button type="button" variant="ghost" size="sm" className="shrink-0" onClick={showMobileTimeline}>
                      <ArrowLeft className="size-4" aria-hidden="true" />
                      {t('mobileBackToTimeline')}
                    </Button>
                    <h2 ref={mobileDetailHeadingRef} tabIndex={-1}
                      className="min-w-0 flex-1 truncate text-right text-sm font-semibold outline-none">
                      {mobileDetailTitle}
                    </h2>
                  </div>
                  <FileVersionComparison
                    request={request}
                    timeline={timeline}
                    selection={selection}
                    onTimelineInvalidate={invalidateTimeline}
                    onContinue={continueEditing}
                    onGraphReviewStatus={onGraphReviewStatus}
                    localSyncPending={localCollaborationPending}
                    isRevalidating={loading || externalRefresh}
                    isStale={Boolean(error) || invalidatedTarget === targetIdentity || unsavedReviewDocument}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </DialogContent>
      ) : workspaceReviewRequest ? (
        <WorkspaceOperationReviewPanel
          key={JSON.stringify([authScope, activeWorkspaceId, workspaceReviewRequest])}
          request={workspaceReviewRequest}
        />
      ) : null}
    </Dialog>
  );
}
