import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import {
  ProposalCurrentProofSchemaV1,
  ProposalDocumentScopeSchemaV1,
  ProposalEvaluationStatusSchemaV1,
  ProposalLifecycleSchemaV1,
  ProposalRelationshipsSchemaV1,
  PROPOSAL_GRAPH_LIMITS,
} from './proposal-graph-v1';

/** FVRC-1005 is a read-only, additive projection. It deliberately carries no path or content. */
export const PROPOSAL_REVIEW_PROJECTION_CONTRACT_VERSION = 1 as const;
const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' });
const Hash = Type.String({ minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' });
const Counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Cursor = Type.String({ minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9._~+/=-]{1,256}$' });
const closed = { additionalProperties: false } as const;
const Version = Type.Literal(PROPOSAL_REVIEW_PROJECTION_CONTRACT_VERSION);

export const ProposalReviewGraphScopeSchemaV1 = Type.Object({
  scope: ProposalDocumentScopeSchemaV1, graphRevision: Counter, rootProposalId: Id,
}, closed);
export type ProposalReviewGraphScopeV1 = Static<typeof ProposalReviewGraphScopeSchemaV1>;

export const ProposalReviewProposalSchemaV1 = Type.Object({
  proposalId: Id, operationId: Id, rootProposalId: Id, parentProposalId: Type.Union([Id, Type.Null()]),
  relation: Type.Union([Type.Literal('root'), Type.Literal('dependency'), Type.Literal('replacement'), Type.Literal('alternative'), Type.Literal('detached')]),
  relationships: ProposalRelationshipsSchemaV1, lifecycle: ProposalLifecycleSchemaV1,
  createdAt: Counter, createdByActorId: Id,
}, closed);
export type ProposalReviewProposalV1 = Static<typeof ProposalReviewProposalSchemaV1>;

export const ProposalReviewEvaluationBindingSchemaV1 = Type.Object({
  evaluationId: Id, proposalId: Id, status: ProposalEvaluationStatusSchemaV1,
  current: ProposalCurrentProofSchemaV1, candidateHash: Type.Union([Hash, Type.Null()]), evaluatedAt: Counter,
}, closed);
export type ProposalReviewEvaluationBindingV1 = Static<typeof ProposalReviewEvaluationBindingSchemaV1>;

const ActionState = Type.Union([Type.Literal('available'), Type.Literal('unavailable'), Type.Literal('denied'), Type.Literal('stale')]);
export const ProposalReviewActionabilitySchemaV1 = Type.Object({
  read: ActionState, write: ActionState,
  inspect: ActionState, compare: ActionState, accept: ActionState, reject: ActionState,
  restore: ActionState, continueEditing: ActionState,
}, closed);
export type ProposalReviewActionabilityV1 = Static<typeof ProposalReviewActionabilitySchemaV1>;

export const ProposalReviewPageBindingSchemaV1 = Type.Object({
  pageIndex: Type.Integer({ minimum: 0, maximum: 1_000_000 }), pageSize: Type.Integer({ minimum: 1, maximum: 256 }),
  nextCursor: Type.Union([Cursor, Type.Null()]), previousCursor: Type.Union([Cursor, Type.Null()]), cursorRevision: Counter,
}, closed);
export type ProposalReviewPageBindingV1 = Static<typeof ProposalReviewPageBindingSchemaV1>;

const DiagnosisReason = Type.Union([
  Type.Literal('graph_unavailable'), Type.Literal('scope_mismatch'), Type.Literal('stale_evaluation'),
  Type.Literal('content_unavailable'), Type.Literal('access_denied'), Type.Literal('invalid_projection'),
  Type.Literal('invalid_request'), Type.Literal('unsupported_version'), Type.Literal('limit_exceeded'),
  Type.Literal('source_invalid'), Type.Literal('parent_changed'), Type.Literal('cycle'),
  Type.Literal('dependency_blocked'), Type.Literal('prerequisite_lost'), Type.Literal('graph_changed'),
  Type.Literal('current_changed'), Type.Literal('candidate_changed'), Type.Literal('choice_conflict'),
  Type.Literal('batch_conflict'), Type.Literal('stale_lifecycle'), Type.Literal('fence_expired'),
  Type.Literal('invalid_transition'), Type.Literal('idempotency_mismatch'), Type.Literal('recovery_required'),
  Type.Literal('no_effect'), Type.Literal('legacy_blocked'), Type.Literal('upgrade_required'),
]);
export const ProposalReviewDiagnosisSchemaV1 = Type.Union([
  Type.Object({ availability: Type.Literal('available'), reasonCode: Type.Null(), correlationId: Id, timestamp: Counter, buildMarker: Id }, closed),
  Type.Object({ availability: Type.Literal('unavailable'), reasonCode: DiagnosisReason, correlationId: Id, timestamp: Counter, buildMarker: Id }, closed),
]);
export type ProposalReviewDiagnosisV1 = Static<typeof ProposalReviewDiagnosisSchemaV1>;

export const ProposalReviewProjectionSchemaV1 = Type.Object({
  contractVersion: Version, graph: ProposalReviewGraphScopeSchemaV1, proposal: ProposalReviewProposalSchemaV1,
  evaluation: Type.Union([ProposalReviewEvaluationBindingSchemaV1, Type.Null()]),
  authorizedProposalIds: Type.Array(Id, { minItems: 0, maxItems: PROPOSAL_GRAPH_LIMITS.closureNodes, uniqueItems: true }),
  selection: Type.Object({
    selectionId: Id,
    selectedProposalIds: Type.Array(Id, { minItems: 1, maxItems: PROPOSAL_GRAPH_LIMITS.batchMembers, uniqueItems: true }),
    graphRevision: Counter,
  }, closed),
  actionability: ProposalReviewActionabilitySchemaV1,
  page: ProposalReviewPageBindingSchemaV1, diagnosis: ProposalReviewDiagnosisSchemaV1,
}, closed);
export type ProposalReviewProjectionV1 = Static<typeof ProposalReviewProjectionSchemaV1>;

/** Additive page envelope used by the read-only graph browser. It never carries content or paths. */
export const ProposalReviewProjectionPageSchemaV1 = Type.Object({
  contractVersion: Version,
  scope: ProposalReviewGraphScopeSchemaV1,
  items: Type.Array(ProposalReviewProposalSchemaV1, { maxItems: 256 }),
  authorizedProposalIds: Type.Array(Id, { uniqueItems: true, maxItems: PROPOSAL_GRAPH_LIMITS.closureNodes }),
  selectedProposalIds: Type.Array(Id, { uniqueItems: true, maxItems: PROPOSAL_GRAPH_LIMITS.batchMembers }),
  actionability: ProposalReviewActionabilitySchemaV1,
  page: ProposalReviewPageBindingSchemaV1,
  diagnosis: ProposalReviewDiagnosisSchemaV1,
}, closed);
export type ProposalReviewProjectionPageV1 = Static<typeof ProposalReviewProjectionPageSchemaV1>;

export function parseProposalReviewProjectionPageV1(value: unknown): ProposalReviewProjectionPageV1 {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { throw new Error('Proposal review projection page must be JSON.'); }
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > PROPOSAL_GRAPH_LIMITS.payloadBytes) throw new Error('Projection page exceeds limits.');
  if (!Value.Check(ProposalReviewProjectionPageSchemaV1, value)) throw new Error('Projection page does not match contract version 1.');
  const page = value as ProposalReviewProjectionPageV1;
  if (page.page.cursorRevision !== page.scope.graphRevision) throw new Error('Page cursor is bound to a different graph revision.');
  if (!page.selectedProposalIds.every((id) => page.authorizedProposalIds.includes(id))) throw new Error('Selection contains an unauthorized proposal.');
  if (!page.items.every((item) => page.authorizedProposalIds.includes(item.proposalId))) throw new Error('Page contains an unauthorized proposal.');
  return page;
}

export function parseProposalReviewProjectionV1(value: unknown): ProposalReviewProjectionV1 {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch { throw new Error('Proposal review projection must be JSON.'); }
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > PROPOSAL_GRAPH_LIMITS.payloadBytes) throw new Error('Proposal review projection exceeds limits.');
  if (!Value.Check(ProposalReviewProjectionSchemaV1, value)) throw new Error('Proposal review projection does not match contract version 1.');
  const projection = value as ProposalReviewProjectionV1;
  if (projection.proposal.rootProposalId !== projection.graph.rootProposalId) throw new Error('Proposal root does not match graph scope.');
  if (projection.evaluation && projection.evaluation.proposalId !== projection.proposal.proposalId) throw new Error('Evaluation binding does not match proposal.');
  if (!projection.authorizedProposalIds.includes(projection.proposal.proposalId)) throw new Error('Projection proposal is not authorized.');
  if (projection.selection.graphRevision !== projection.graph.graphRevision) throw new Error('Selection is bound to a different graph revision.');
  if (!projection.selection.selectedProposalIds.every((id) => projection.authorizedProposalIds.includes(id))) throw new Error('Selection contains an unauthorized proposal.');
  if (projection.page.cursorRevision !== projection.graph.graphRevision) throw new Error('Page cursor is bound to a different graph revision.');
  return projection;
}
