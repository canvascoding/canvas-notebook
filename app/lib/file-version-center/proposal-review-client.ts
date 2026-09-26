'use client';

import { WORKSPACE_ID_HEADER } from '../workspaces/constants';
import { parseProposalActionReceiptV1, PROPOSAL_GRAPH_ERROR_CODES, type ProposalActionReceiptV1 } from './contracts/proposal-graph-v1';
import { parseProposalReviewSessionRequestV1, parseProposalReviewSessionResponseV1, parseProposalReviewActionApiRequestV1,
  parseProposalReviewActionStatusRequestV1, type ProposalReviewActionStatusRequestV1, type ProposalReviewActionStatusResponseV1,
  type ProposalReviewSessionRequestV1, type ProposalReviewSessionResponseV1, type ProposalReviewActionApiRequestV1 } from './contracts/proposal-review-session-v1';
import { parseProposalReviewCompareApiRequestV1, type ProposalReviewCompareApiRequestV1 } from './contracts/proposal-review-compare-api-v1';
import type { ProposalReviewCompareResponseV1 } from './contracts/proposal-review-compare-v1';
import { FILE_VERSION_CENTER_ERROR_CODES } from './contracts/v1';
import { parseProposalReviewTransformRequestV1, parseProposalReviewTransformResponseV1,
  type ProposalReviewTransformRequestV1, type ProposalReviewTransformResponseV1 } from './contracts/proposal-review-transform-v1';
import { parseProposalReviewSummaryRequestV1, parseProposalReviewSummaryResponseV1,
  type ProposalReviewSummaryRequestV1, type ProposalReviewSummaryResponseV1 } from './contracts/proposal-review-summary-v1';

export type ProposalReviewClientDiagnosis = {
  reasonCode: string; phase: 'review' | 'compare' | 'action'; correlationId: string | null; timestamp: number; buildMarker: string | null;
};
export class ProposalReviewClientError extends Error {
  constructor(readonly code: string, readonly status: number, readonly diagnosis: ProposalReviewClientDiagnosis) {
    super('The proposal review request could not be completed.');
    this.name = 'ProposalReviewClientError';
  }
}
const codes = new Set<string>([...Object.values(PROPOSAL_GRAPH_ERROR_CODES), ...Object.values(FILE_VERSION_CENTER_ERROR_CODES)]);
function failure(status: number, phase: ProposalReviewClientDiagnosis['phase'], payload?: unknown): ProposalReviewClientError {
  const error = payload && typeof payload === 'object' && 'error' in payload ? payload.error : null;
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const code = typeof record.code === 'string' && codes.has(record.code) ? record.code : 'FVRC_TRANSPORT_ERROR';
  const safeRef = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
  return new ProposalReviewClientError(code, status, { reasonCode: code, phase,
    correlationId: safeRef(record.correlationId), timestamp: typeof record.timestamp === 'number' && Number.isSafeInteger(record.timestamp) ? record.timestamp : Date.now(),
    buildMarker: safeRef(record.buildMarker) });
}
function targetMatchesResolvedScope(target: ProposalReviewSessionRequestV1['target'], resolved: {
  workspaceId: string; lineageId: string; documentId: string;
}): boolean {
  if (target.workspaceId !== resolved.workspaceId) return false;
  if (target.kind === 'document') return target.documentId === resolved.documentId;
  if (target.kind === 'lineage') return target.lineageId === resolved.lineageId;
  // Path and change-group targets have no corresponding field in the session
  // response contract. Their stable workspace binding is still checked here.
  return true;
}
function targetMatchesReceiptScope(target: ProposalReviewActionApiRequestV1['target'] | ProposalReviewActionStatusRequestV1['target'], scope: {
  workspaceId: string; lineageId: string; documentId: string;
}): boolean {
  if (target.workspaceId !== scope.workspaceId) return false;
  if (target.kind === 'document') return target.documentId === scope.documentId;
  if (target.kind === 'lineage') return target.lineageId === scope.lineageId;
  // Receipt scopes intentionally omit path/change-group identity.
  return true;
}
function sameProposalScope(left: ProposalActionReceiptV1['scope'], right: ProposalReviewActionApiRequestV1['action']['fence']['scope']): boolean {
  return left.workspaceId === right.workspaceId && left.lineageId === right.lineageId
    && left.documentId === right.documentId && left.lifecycleGeneration === right.lifecycleGeneration
    && left.schemaVersion === right.schemaVersion;
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function post(path: string, workspaceId: string, body: unknown, phase: ProposalReviewClientDiagnosis['phase'], signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/files/version-center/v1/proposals/${path}`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json', [WORKSPACE_ID_HEADER]: workspaceId }, body: JSON.stringify(body),
    });
  } catch (error) {
    if (signal?.aborted || error instanceof DOMException && error.name === 'AbortError') throw error;
    throw failure(0, phase);
  }
  let payload: unknown;
  try { payload = await response.json(); } catch { throw failure(response.status, phase); }
  if (!response.ok) throw failure(response.status, phase, payload);
  return payload;
}
export async function readProposalReviewSession(request: ProposalReviewSessionRequestV1, signal?: AbortSignal): Promise<ProposalReviewSessionResponseV1> {
  parseProposalReviewSessionRequestV1(request);
  const payload = await post('review', request.target.workspaceId, request, 'review', signal);
  try {
    const result = parseProposalReviewSessionResponseV1(payload);
    if (result.mode === 'legacy') {
      if (request.selection.kind !== 'operation') throw failure(200, 'review');
      return result;
    }
    if (!targetMatchesResolvedScope(request.target, result.target)) throw failure(200, 'review');
    if (request.selection.kind === 'proposals'
      && JSON.stringify(result.selectedProposalIds) !== JSON.stringify(request.selection.proposalIds)) throw failure(200, 'review');
    if (request.selection.kind === 'operation') {
      if (result.selectedProposalIds.length !== 1) throw failure(200, 'review');
      const context = result.context;
      if (context && context.proposals.length > 0) {
        const selectedProposal = context.proposals.find(proposal => result.selectedProposalIds.includes(proposal.proposalId));
        if (!selectedProposal || selectedProposal.operationId !== request.selection.operationId) throw failure(200, 'review');
      } else if (context && context.reasonCode === null) throw failure(200, 'review');
    }
    return result;
  } catch { throw failure(200, 'review'); }
}

export async function readProposalReviewSummary(request: ProposalReviewSummaryRequestV1,
  signal?: AbortSignal): Promise<ProposalReviewSummaryResponseV1> {
  parseProposalReviewSummaryRequestV1(request);
  const payload = await post('summary', request.target.workspaceId, request, 'review', signal);
  try {
    const result = parseProposalReviewSummaryResponseV1(payload);
    if (result.target.workspaceId !== request.target.workspaceId
      || request.target.kind === 'document' && result.target.documentId !== request.target.documentId
      || request.target.kind === 'lineage' && result.target.lineageId !== request.target.lineageId
      || JSON.stringify(result.items.map(item => item.operationId)) !== JSON.stringify(request.operationIds)) throw failure(200, 'review');
    return result;
  } catch { throw failure(200, 'review'); }
}

export async function previewProposalReviewTransform(request: ProposalReviewTransformRequestV1,
  signal?: AbortSignal): Promise<ProposalReviewTransformResponseV1> {
  parseProposalReviewTransformRequestV1(request);
  const payload = await post('transform/preview', request.target.workspaceId, request, 'review', signal);
  try {
    const result = parseProposalReviewTransformResponseV1(payload);
    const { fence, creation } = result.prepared;
    if (result.kind !== request.kind || result.sourceProposalId !== request.sourceProposalId
      || fence.actionType !== request.kind || creation.creationKind !== (request.kind === 'detach' ? 'detached' : 'replacement')
      || request.kind === 'detach' && creation.detachedFromProposalId !== request.sourceProposalId
      || request.kind === 'replace' && creation.relationships.replacesProposalId !== request.sourceProposalId
      || fence.scope.workspaceId !== request.target.workspaceId
      || request.target.kind === 'document' && fence.scope.documentId !== request.target.documentId
      || request.target.kind === 'lineage' && fence.scope.lineageId !== request.target.lineageId
      || fence.graphRevision !== request.expectedGraphRevision
      || JSON.stringify(fence.selectedProposalIds) !== JSON.stringify([request.sourceProposalId])) throw failure(200, 'review');
    const hashText = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
    const [beforeHash, proposedHash] = await Promise.all([hashText(result.beforeContent), hashText(result.proposedContent)]);
    if (beforeHash !== result.beforeSha256 || proposedHash !== result.proposedSha256) throw failure(200, 'review');
    return result;
  } catch { throw failure(200, 'review'); }
}
export async function compareProposalReviewSelection(request: ProposalReviewCompareApiRequestV1, signal?: AbortSignal): Promise<ProposalReviewCompareResponseV1> {
  parseProposalReviewCompareApiRequestV1(request);
  const payload = await post('compare', request.target.workspaceId, request, 'compare', signal);
  try {
    // Reuse the strict transport schema and selection binding checks, without admitting action authority.
    const session = parseProposalReviewSessionResponseV1({ contractVersion: 1, mode: 'graph', target: request.target,
      selectedProposalIds: request.selectedProposalIds, status: 'unavailable', reasonCode: null, compare: payload,
      actions: {}, capability: { write: false }, diagnosis: { reasonCode: null, phase: 'review', correlationId: 'compare', timestamp: Date.now(), buildMarker: 'fvrc-1006' } });
    if (session.mode !== 'graph' || !session.compare) throw failure(200, 'compare');
    if (request.binding) {
      const binding = session.compare.binding;
      if (!binding || binding.evaluationId !== request.binding.evaluationId || binding.selectionHash !== request.binding.selectionHash
        || binding.graphRevision !== request.binding.graphRevision
        || Object.keys(binding.current).some(key => binding.current[key as keyof typeof binding.current] !== request.binding!.current[key as keyof typeof binding.current])) {
        throw failure(200, 'compare');
      }
    }
    return session.compare;
  } catch { throw failure(200, 'compare'); }
}
export async function executeProposalReviewAction(request: ProposalReviewActionApiRequestV1, signal?: AbortSignal): Promise<ProposalActionReceiptV1> {
  parseProposalReviewActionApiRequestV1(request);
  const payload = await post('actions', request.target.workspaceId, request, 'action', signal);
  try {
    const receipt = parseProposalActionReceiptV1(payload);
    if (receipt.requestDigest !== request.action.fence.requestDigest || receipt.actorId !== request.action.fence.actor.userId
      || receipt.actionType !== request.action.fence.actionType
      || !sameProposalScope(receipt.scope, request.action.fence.scope)
      || !targetMatchesReceiptScope(request.target, receipt.scope)) throw failure(200, 'action');
    return receipt;
  } catch { throw failure(200, 'action'); }
}

/** After reload only persist/query this opaque identity, never the transport-only signed fence token. */
export async function readProposalReviewActionStatus(request: ProposalReviewActionStatusRequestV1, signal?: AbortSignal): Promise<ProposalReviewActionStatusResponseV1> {
  parseProposalReviewActionStatusRequestV1(request);
  const payload = await post('actions/status', request.target.workspaceId, request, 'action', signal);
  try {
    if (!payload || typeof payload !== 'object' || !('receipt' in payload) || !('checkedAt' in payload)
      || typeof payload.checkedAt !== 'number' || !Number.isSafeInteger(payload.checkedAt) || payload.checkedAt < 0) throw failure(200, 'action');
    if (payload.receipt === null) return { receipt: null, checkedAt: payload.checkedAt };
    const receipt = parseProposalActionReceiptV1(payload.receipt);
    if (receipt.requestDigest !== request.requestDigest || !targetMatchesReceiptScope(request.target, receipt.scope)
      || receipt.idempotencyKeyHash !== await sha256(request.idempotencyKey)) throw failure(200, 'action');
    return { receipt, checkedAt: payload.checkedAt };
  } catch { throw failure(200, 'action'); }
}
