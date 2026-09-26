import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { FileVersionCenterTargetSchemaV1, FileVersionCenterContractError, FILE_VERSION_CENTER_ERROR_CODES } from './v1';
import { ProposalReviewProposalSchemaV1 } from './proposal-review-projection-v1';
import { ProposalActionFenceSchemaV1, ProposalActionRequestSchemaV1, ProposalCurrentProofSchemaV1,
  ProposalEvaluationStatusSchemaV1, PROPOSAL_GRAPH_ERROR_CODES, PROPOSAL_GRAPH_LIMITS, parseProposalActionRequestV1,
  type ProposalActionFenceV1, type ProposalActionReceiptV1, type ProposalGraphErrorCode } from './proposal-graph-v1';

const closed = { additionalProperties: false };
const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' });
const Ids = Type.Array(Id, { maxItems: PROPOSAL_GRAPH_LIMITS.batchMembers, uniqueItems: true });
const Hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const Count = Type.Integer({ minimum: 0 });
// Preserve the static enum type; a mapped literal array otherwise erases the
// non-null branch in TypeBox. Runtime validation still uses the exact literals.
const Reason = Type.Unsafe<ProposalGraphErrorCode | null>(
  Type.Union([Type.Null(), ...Object.values(PROPOSAL_GRAPH_ERROR_CODES).map(code => Type.Literal(code))]),
);
export const ProposalReviewSessionRequestSchemaV1 = Type.Object({
  contractVersion: Type.Literal(1), target: FileVersionCenterTargetSchemaV1,
  selection: Type.Union([
    Type.Object({ kind: Type.Literal('operation'), operationId: Id }, closed),
    Type.Object({ kind: Type.Literal('all') }, closed),
    Type.Object({ kind: Type.Literal('proposals'), proposalIds: Type.Array(Id, { minItems: 1, maxItems: PROPOSAL_GRAPH_LIMITS.batchMembers, uniqueItems: true }) }, closed),
  ]),
}, closed);
export type ProposalReviewSessionRequestV1 = Static<typeof ProposalReviewSessionRequestSchemaV1>;

export type PreparedProposalReviewActionV1 = { fence: ProposalActionFenceV1; fenceToken: string };
const Prepared = Type.Object({ fence: ProposalActionFenceSchemaV1,
  fenceToken: Type.String({ pattern: '^pg1\\.[A-Za-z0-9_-]{43}$' }) }, closed);
const Binding = Type.Object({ evaluationId: Id, selectionHash: Hash, selectedProposalIds: Ids,
  current: ProposalCurrentProofSchemaV1, graphRevision: Count }, closed);
const Compare = Type.Object({
  contractVersion: Type.Literal(1), binding: Type.Union([Binding, Type.Null()]),
  status: Type.Union([ProposalEvaluationStatusSchemaV1, Type.Null()]),
  candidate: Type.Object({ contentAvailable: Type.Boolean(), noEffect: Type.Boolean() }, closed),
  summary: Type.Object({ additions: Count, deletions: Count, unchanged: Count }, closed),
  hunks: Type.Array(Type.Object({ id: Type.String(), oldStart: Count, oldLines: Count, newStart: Count, newLines: Count,
    lines: Type.Array(Type.Object({ kind: Type.Union([Type.Literal('context'), Type.Literal('addition'), Type.Literal('deletion')]),
      oldLineNumber: Type.Union([Count, Type.Null()]), newLineNumber: Type.Union([Count, Type.Null()]), text: Type.String() }, closed)),
  }, closed), { maxItems: 64 }),
  page: Type.Object({ hasMore: Type.Boolean(), nextCursor: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]) }, closed),
  diagnosis: Type.Object({ availability: Type.Union([Type.Literal('available'), Type.Literal('unavailable')]), reasonCode: Reason }, closed),
}, closed);
const Diagnosis = Type.Object({ reasonCode: Reason, phase: Type.Literal('review'), correlationId: Id,
  timestamp: Type.Integer({ minimum: 0 }), buildMarker: Type.String({ maxLength: 128 }) }, closed);
export const ProposalReviewContextSchemaV1 = Type.Object({ graphRevision: Count,
  proposals: Type.Array(ProposalReviewProposalSchemaV1, { maxItems: PROPOSAL_GRAPH_LIMITS.nodesPerSnapshot }),
  selectedProposalIds: Ids, dependencyProposalIds: Type.Array(Id, { maxItems: PROPOSAL_GRAPH_LIMITS.closureNodes, uniqueItems: true }),
  applyProposalIds: Type.Array(Id, { maxItems: PROPOSAL_GRAPH_LIMITS.closureNodes, uniqueItems: true }),
  closingAlternativeProposalIds: Type.Array(Id, { maxItems: PROPOSAL_GRAPH_LIMITS.closureNodes, uniqueItems: true }), reasonCode: Reason }, closed);
export type ProposalReviewContextV1 = Static<typeof ProposalReviewContextSchemaV1>;
export const ProposalReviewSessionResponseSchemaV1 = Type.Union([
  Type.Object({ contractVersion: Type.Literal(1), mode: Type.Literal('legacy') }, closed),
  Type.Object({ contractVersion: Type.Literal(1), mode: Type.Literal('graph'),
    target: Type.Object({ kind: Type.Literal('document'), workspaceId: Id, lineageId: Id, documentId: Id }, closed),
    selectedProposalIds: Ids, status: ProposalEvaluationStatusSchemaV1, reasonCode: Reason,
    context: Type.Optional(ProposalReviewContextSchemaV1),
    compare: Type.Union([Compare, Type.Null()]),
    actions: Type.Object({ accept: Type.Optional(Prepared), reject: Type.Optional(Prepared), branchReject: Type.Optional(Prepared), completeSatisfied: Type.Optional(Prepared) }, closed),
    capability: Type.Object({ write: Type.Boolean() }, closed), diagnosis: Diagnosis,
  }, closed),
]);
export type ProposalReviewSessionResponseV1 = Static<typeof ProposalReviewSessionResponseSchemaV1>;
export type ProposalReviewGraphSessionV1 = Extract<ProposalReviewSessionResponseV1, { mode: 'graph' }>;

export const ProposalReviewActionApiRequestSchemaV1 = Type.Object({
  contractVersion: Type.Literal(1), target: FileVersionCenterTargetSchemaV1, action: ProposalActionRequestSchemaV1,
}, closed);
export type ProposalReviewActionApiRequestV1 = Static<typeof ProposalReviewActionApiRequestSchemaV1>;

export const ProposalReviewActionStatusRequestSchemaV1 = Type.Object({ contractVersion: Type.Literal(1), target: FileVersionCenterTargetSchemaV1,
  idempotencyKey: Type.String({ minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' }), requestDigest: Hash,
  approvalExpiresAt: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, closed);
export type ProposalReviewActionStatusRequestV1 = Static<typeof ProposalReviewActionStatusRequestSchemaV1>;
export type ProposalReviewActionStatusResponseV1 = { receipt: ProposalActionReceiptV1 | null; checkedAt: number };
export function parseProposalReviewActionStatusRequestV1(value: unknown): ProposalReviewActionStatusRequestV1 {
  if (!Value.Check(ProposalReviewActionStatusRequestSchemaV1, value)) invalid();
  return value as ProposalReviewActionStatusRequestV1;
}

function invalid(): never {
  throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.invalidRequest, 'The proposal review contract is invalid.');
}
export function parseProposalReviewSessionRequestV1(value: unknown): ProposalReviewSessionRequestV1 {
  if (!Value.Check(ProposalReviewSessionRequestSchemaV1, value)) invalid();
  return value as ProposalReviewSessionRequestV1;
}
export function parseProposalReviewSessionResponseV1(value: unknown): ProposalReviewSessionResponseV1 {
  if (!Value.Check(ProposalReviewSessionResponseSchemaV1, value)) invalid();
  const result = value as ProposalReviewSessionResponseV1;
  if (result.mode === 'legacy') return result;
  const selected = JSON.stringify(result.selectedProposalIds);
  if (result.context) {
    const contextIds = new Set(result.context.proposals.map(proposal => proposal.proposalId));
    const unavailableContext = contextIds.size === 0 && result.context.reasonCode !== null
      && result.context.dependencyProposalIds.length === 0 && result.context.applyProposalIds.length === 0
      && result.context.closingAlternativeProposalIds.length === 0;
    if (JSON.stringify(result.context.selectedProposalIds) !== selected
      || !unavailableContext && [...result.context.selectedProposalIds, ...result.context.dependencyProposalIds, ...result.context.applyProposalIds,
        ...result.context.closingAlternativeProposalIds].some(id => !contextIds.has(id))
      || result.compare?.binding && result.compare.binding.graphRevision !== result.context.graphRevision) invalid();
  }
  if (result.compare?.binding && JSON.stringify(result.compare.binding.selectedProposalIds) !== selected) invalid();
  for (const [kind, prepared] of Object.entries(result.actions)) {
    if (!prepared || !result.capability.write) invalid();
    const { fence } = prepared;
    if (JSON.stringify(fence.selectedProposalIds) !== selected || fence.scope.workspaceId !== result.target.workspaceId
      || fence.scope.documentId !== result.target.documentId || fence.scope.lineageId !== result.target.lineageId) invalid();
    if (kind === 'reject' || kind === 'branchReject') {
      if (fence.actionType !== (kind === 'reject' ? 'reject' : 'branch_reject')) invalid();
      continue;
    }
    if (kind === 'accept' && (result.status !== 'clean' && result.status !== 'clean_rebased'
      || !['accept', 'batch_accept'].includes(fence.actionType))) invalid();
    if (kind === 'completeSatisfied' && (fence.actionType !== 'complete_satisfied'
      || !['empty_effect', 'satisfied_elsewhere'].includes(result.status))) invalid();
    const binding = result.compare?.binding;
    if (!binding || !(result.compare?.candidate.contentAvailable || result.compare?.candidate.noEffect) || binding.evaluationId !== fence.evaluationId
      || binding.graphRevision !== fence.graphRevision || !fence.current
      || Object.keys(binding.current).some(key => binding.current[key as keyof typeof binding.current] !== fence.current?.[key as keyof typeof binding.current])) invalid();
  }
  return result;
}
export function parseProposalReviewActionApiRequestV1(value: unknown): ProposalReviewActionApiRequestV1 {
  if (!Value.Check(ProposalReviewActionApiRequestSchemaV1, value)) invalid();
  const result = value as ProposalReviewActionApiRequestV1;
  parseProposalActionRequestV1(result.action);
  const createsProposal = ['detach', 'replace'].includes(result.action.fence.actionType);
  if (!['accept', 'batch_accept', 'reject', 'branch_reject', 'complete_satisfied', 'detach', 'replace'].includes(result.action.fence.actionType)
    || createsProposal !== (result.action.creation !== null)) invalid();
  return result;
}
