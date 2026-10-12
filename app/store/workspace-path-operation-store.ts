'use client';

import { create } from 'zustand';
import { beginExternalWorkspaceNavigation } from '@/app/lib/workspaces/navigation-sync';
import { openedDocumentAuthScope, type OpenedDocumentAuthScope } from '@/app/lib/collaboration/opened-document-registry';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import type { WorkspacePathOperationResponse } from '@/app/lib/files/workspace-path-operation-public';
import { readWorkspacePathOperation } from '@/app/lib/files/workspace-path-operation-parser';
import type { WorkspacePathOperationProblem } from '@/app/lib/files/workspace-path-operation-problems';
import { useWorkspaceStore } from './workspace-store';

export type WorkspacePathOperationStatusTarget = { workspaceId: string }
  & ({ batchId: string; problemId?: never; reviewId?: never; documentReviewPaused?: never }
    | { problemId: string; batchId?: never; reviewId?: never; documentReviewPaused?: never }
    | { reviewId: string; batchId?: never; problemId?: never; documentReviewPaused?: never }
    | { documentReviewPaused: true; batchId?: never; problemId?: never; reviewId?: never });
export type WorkspacePathOperationStatusRequest = WorkspacePathOperationStatusTarget & { authScope: OpenedDocumentAuthScope };
export type WorkspacePathOperationStatusResponse = WorkspacePathOperationResponse & { recovery?: { canResume: boolean; canUndo: boolean } };
export type WorkspacePathOperationLegacyReviewStatus = {
  reviewId: string; kind: 'move' | 'rename' | 'delete' | 'copy';
  status: 'pending' | 'queued' | 'applying' | 'applied' | 'rejected' | 'stale' | 'failed' | 'needs_recovery' | 'blocked';
  selections: Array<{ sourcePath: string; destinationPath?: string }>; errorCode: string | null;
  batchId: string | null;
};
type State = {
  request: WorkspacePathOperationStatusRequest | null;
  response: WorkspacePathOperationStatusResponse | null;
  problem: WorkspacePathOperationProblem | null;
  review: WorkspacePathOperationLegacyReviewStatus | null;
  loading: boolean; busy: boolean;
  pendingAction: 'resume' | 'undo' | null;
  error: 'load' | 'action' | 'access' | 'identity' | null;
  errorCode: string | null;
};
const initial: State = { request: null, response: null, problem: null, review: null, loading: false, busy: false,
  pendingAction: null, error: null, errorCode: null };
export const useWorkspacePathOperationStore = create<State>(() => initial);
let generation = 0;
let navigationGeneration = 0;
let controller: AbortController | null = null;
let opener: HTMLElement | null = null;
const pinnedPlans = new WeakMap<WorkspacePathOperationStatusRequest, string>();
const resolvedBatches = new WeakMap<WorkspacePathOperationStatusRequest, string>();
const batchFor = (request: WorkspacePathOperationStatusRequest) => request.batchId ?? resolvedBatches.get(request);

const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(value);
const safeCode = (value: unknown): string | null => typeof value === 'string' && /^[A-Z0-9_:-]{1,100}$/u.test(value) ? value : null;
const requestCurrent = (request: WorkspacePathOperationStatusRequest) =>
  useWorkspacePathOperationStore.getState().request === request && openedDocumentAuthScope() === request.authScope
  && useWorkspaceStore.getState().activeWorkspaceId === request.workspaceId;

function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && !value.startsWith('/')
    && !value.includes('\\') && !value.split('/').includes('..') && !/[\p{Cc}\p{Cf}]/u.test(value)
    && !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value);
}

function validSelections(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 1000 && value.every((selection) => selection && typeof selection === 'object'
    && validPath(selection.sourcePath) && (selection.destinationPath === undefined || validPath(selection.destinationPath)));
}

function readOperation(payload: unknown, request: WorkspacePathOperationStatusRequest, planId?: string): WorkspacePathOperationStatusResponse {
  const value = payload as WorkspacePathOperationStatusResponse | null;
  const expectedPlan = planId ?? pinnedPlans.get(request);
  let operation;
  try {
    if (!batchFor(request)) throw new Error('identity');
    operation = readWorkspacePathOperation(value?.operation,
      { batchId: batchFor(request), workspaceId: request.workspaceId, planId: expectedPlan });
  } catch { throw new Error('identity'); }
  if (!value || value.recovery && (typeof value.recovery.canResume !== 'boolean' || typeof value.recovery.canUndo !== 'boolean')) {
    throw new Error('identity');
  }
  pinnedPlans.set(request, operation.planId);
  return { operation,
  ...(value.recovery ? { recovery: { canResume: value.recovery.canResume, canUndo: value.recovery.canUndo } } : {}) };
}

function readLegacyReview(payload: unknown, request: WorkspacePathOperationStatusRequest): WorkspacePathOperationLegacyReviewStatus {
  const review = (payload as { review?: WorkspacePathOperationLegacyReviewStatus & {sourceWorkspaceId: string} } | null)?.review;
  if (!review || review.reviewId !== request.reviewId || review.sourceWorkspaceId !== request.workspaceId
    || !['move', 'rename', 'delete', 'copy'].includes(review.kind) || !validSelections(review.selections)
    || !['pending', 'queued', 'applying', 'applied', 'rejected', 'stale', 'failed', 'needs_recovery', 'blocked'].includes(review.status)
    || review.batchId !== undefined && review.batchId !== null && !validId(review.batchId)) throw new Error('identity');
  return { reviewId: review.reviewId, kind: review.kind, status: review.status, errorCode: safeCode(review.errorCode),
    selections: review.selections.map(({ sourcePath, destinationPath }) => ({ sourcePath, ...(destinationPath ? {destinationPath} : {}) })),
    batchId: review.batchId ?? null };
}

function readProblem(payload: unknown, request: WorkspacePathOperationStatusRequest): WorkspacePathOperationProblem {
  const problem = (payload as { problem?: WorkspacePathOperationProblem } | null)?.problem;
  if (!problem || problem.problemId !== request.problemId || problem.workspaceId !== request.workspaceId
    || !['move', 'rename', 'delete'].includes(problem.kind) || !validSelections(problem.selections)
    || !safeCode(problem.errorCode) || !Number.isFinite(problem.createdAt) || !Number.isFinite(problem.updatedAt)) throw new Error('identity');
  return { problemId: problem.problemId, workspaceId: problem.workspaceId, kind: problem.kind,
    selections: problem.selections.map(({ sourcePath, destinationPath }) => ({ sourcePath, ...(destinationPath ? { destinationPath } : {}) })),
    errorCode: problem.errorCode, createdAt: problem.createdAt, updatedAt: problem.updatedAt };
}

function publishResult(request: WorkspacePathOperationStatusRequest, response: WorkspacePathOperationStatusResponse) {
  if (!requestCurrent(request)) return;
  const pendingAction = useWorkspacePathOperationStore.getState().pendingAction;
  const running = ['queued', 'applying'].includes(response.operation.status);
  const expected = pendingAction === 'undo' ? 'undone' : 'applied';
  useWorkspacePathOperationStore.setState({ response, problem: null, review: null, loading: false,
    busy: Boolean(pendingAction && running), pendingAction: running ? pendingAction : null,
    error: pendingAction && !running && response.operation.status !== expected ? 'action' : null,
    errorCode: response.operation.errorCode });
  if (pendingAction && !running && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('notification_summary_updated'));
}

export async function openWorkspacePathOperationStatus(target: WorkspacePathOperationStatusTarget): Promise<boolean> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(target.workspaceId)
    || [target.batchId, target.problemId, target.reviewId, target.documentReviewPaused].filter(Boolean).length !== 1
    || !target.documentReviewPaused && !validId(target.batchId ?? target.problemId ?? target.reviewId)) return false;
  const authScope = openedDocumentAuthScope();
  if (!authScope) return false;
  const opening = ++navigationGeneration;
  const release = beginExternalWorkspaceNavigation();
  try {
    await useWorkspaceStore.getState().hydrateWorkspaces();
    if (opening !== navigationGeneration || openedDocumentAuthScope() !== authScope) return false;
    if (useWorkspaceStore.getState().activeWorkspaceId !== target.workspaceId) {
      await useWorkspaceStore.getState().setActiveWorkspace(target.workspaceId, 'system');
    }
    if (opening !== navigationGeneration || openedDocumentAuthScope() !== authScope
      || useWorkspaceStore.getState().activeWorkspaceId !== target.workspaceId) return false;
    generation += 1; controller?.abort(); controller = null;
    opener = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null;
    useWorkspacePathOperationStore.setState({ ...initial, request: { ...target, authScope } });
    return true;
  } catch { return false; }
  finally { release(); }
}

export function closeWorkspacePathOperationStatus(): void {
  navigationGeneration += 1; generation += 1; controller?.abort(); controller = null;
  const request = useWorkspacePathOperationStore.getState().request;
  useWorkspacePathOperationStore.setState(initial);
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (request && url.searchParams.get('workspaceId') === request.workspaceId) {
    if (url.searchParams.get('workspacePathBatch') === request.batchId) url.searchParams.delete('workspacePathBatch');
    if (url.searchParams.get('workspacePathProblem') === request.problemId) url.searchParams.delete('workspacePathProblem');
    if (url.searchParams.get('workspaceOperationReview') === request.reviewId) url.searchParams.delete('workspaceOperationReview');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }
  const target = opener; opener = null;
  window.requestAnimationFrame(() => { if (target?.isConnected) target.focus({ preventScroll: true }); });
}

export async function reloadWorkspacePathOperationStatus(): Promise<void> {
  const request = useWorkspacePathOperationStore.getState().request;
  if (!request || !requestCurrent(request)) return;
  if (request.documentReviewPaused) return;
  const load = ++generation;
  controller?.abort(); controller = new AbortController();
  useWorkspacePathOperationStore.setState({ loading: true, error: null });
  try {
    const batchId = batchFor(request);
    const response = await fetch(batchId ? `/api/files/operations/batches/${encodeURIComponent(batchId)}`
      : request.reviewId ? `/api/files/operation-reviews/${encodeURIComponent(request.reviewId)}`
      : `/api/files/operations/problems/${encodeURIComponent(request.problemId!)}`, {
      credentials: 'include', headers: { [WORKSPACE_ID_HEADER]: request.workspaceId }, cache: 'no-store', signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as { code?: unknown } | null;
    if (load !== generation || !requestCurrent(request)) return;
    if (!response.ok) {
      const denied = [401, 403, 404].includes(response.status);
      useWorkspacePathOperationStore.setState({ loading: false, busy: false, pendingAction: null,
        response: null, problem: null, review: null, error: denied ? 'access' : 'load', errorCode: safeCode(payload?.code) });
      return;
    }
    if (batchId) publishResult(request, readOperation(payload, request,
      useWorkspacePathOperationStore.getState().response?.operation.planId));
    else if (request.reviewId) {
      const review = readLegacyReview(payload, request);
      if (review.batchId && review.kind !== 'copy') {
        resolvedBatches.set(request, review.batchId);
        await reloadWorkspacePathOperationStatus();
      } else useWorkspacePathOperationStore.setState({ review, response: null, problem: null,
        loading: false, error: null, errorCode: review.errorCode });
    }
    else useWorkspacePathOperationStore.setState({ problem: readProblem(payload, request), response: null,
      review: null, loading: false, error: null, errorCode: null });
  } catch (error) {
    if (load !== generation || !requestCurrent(request)) return;
    useWorkspacePathOperationStore.setState({ response: null, problem: null, review: null, loading: false, busy: false, pendingAction: null,
      error: error instanceof Error && error.message === 'identity' ? 'identity' : 'load', errorCode: null });
  }
}

/** Recovery remains an explicit action authorized again by the server for this exact plan. */
export async function recoverWorkspacePathOperation(action: 'resume' | 'undo'): Promise<void> {
  const state = useWorkspacePathOperationStore.getState();
  const request = state.request;
  const operation = state.response?.operation;
  const batchId = request ? batchFor(request) : undefined;
  if (!request || !batchId || !requestCurrent(request) || !operation || state.busy || state.loading || state.error
    || !(action === 'undo' ? state.response?.recovery?.canUndo : state.response?.recovery?.canResume)) return;
  const mutation = ++generation;
  controller?.abort(); controller = new AbortController();
  useWorkspacePathOperationStore.setState({ busy: true, pendingAction: action, error: null, errorCode: null });
  try {
    const response = await fetch(`/api/files/operations/batches/${encodeURIComponent(batchId)}`, {
      method: 'POST', credentials: 'include', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', [WORKSPACE_ID_HEADER]: request.workspaceId },
      body: JSON.stringify({ action, planId: operation.planId }),
    });
    const payload = await response.json().catch(() => null) as { code?: unknown } | null;
    if (mutation !== generation || !requestCurrent(request)) return;
    if (!response.ok) {
      const denied = [401, 403, 404].includes(response.status);
      useWorkspacePathOperationStore.setState({ busy: false, pendingAction: null, error: denied ? 'access' : 'action',
        errorCode: safeCode(payload?.code), ...(denied ? { response: null, problem: null, review: null } : {}) });
      return;
    }
    publishResult(request, readOperation(payload, request, operation.planId));
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('notification_summary_updated'));
  } catch (error) {
    if (mutation !== generation || !requestCurrent(request)) return;
    const mismatched = error instanceof Error && error.message === 'identity';
    useWorkspacePathOperationStore.setState({ busy: false, pendingAction: null,
      error: mismatched ? 'identity' : 'action', errorCode: null, ...(mismatched ? { response: null, problem: null, review: null } : {}) });
  }
}
