import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { FileVersionCenterTargetSchemaV1, FileVersionCenterContractError, FILE_VERSION_CENTER_ERROR_CODES } from './v1';
import { ProposalCurrentProofSchemaV1, ProposalEvaluationStatusSchemaV1, PROPOSAL_GRAPH_ERROR_CODES,
  PROPOSAL_GRAPH_LIMITS, type ProposalGraphErrorCode } from './proposal-graph-v1';
import { ProposalReviewProposalSchemaV1 } from './proposal-review-projection-v1';

const closed = { additionalProperties: false };
const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' });
const Count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Reason = Type.Unsafe<ProposalGraphErrorCode | null>(
  Type.Union([Type.Null(), ...Object.values(PROPOSAL_GRAPH_ERROR_CODES).map(code => Type.Literal(code))]),
);
export const ProposalReviewSummaryRequestSchemaV1 = Type.Object({
  contractVersion: Type.Literal(1), target: FileVersionCenterTargetSchemaV1,
  operationIds: Type.Array(Id, { minItems: 1, maxItems: PROPOSAL_GRAPH_LIMITS.batchMembers, uniqueItems: true }),
}, closed);
export type ProposalReviewSummaryRequestV1 = Static<typeof ProposalReviewSummaryRequestSchemaV1>;
export const ProposalReviewSummaryResponseSchemaV1 = Type.Object({
  contractVersion: Type.Literal(1),
  target: Type.Object({ workspaceId: Id, lineageId: Id, documentId: Type.Union([Id, Type.Null()]) }, closed),
  current: Type.Union([ProposalCurrentProofSchemaV1, Type.Null()]),
  graphRevision: Type.Union([Count, Type.Null()]), checkedAt: Count,
  items: Type.Array(Type.Union([
    Type.Object({ mode: Type.Literal('legacy'), operationId: Id }, closed),
    Type.Object({ mode: Type.Literal('graph'), operationId: Id,
      proposal: Type.Union([ProposalReviewProposalSchemaV1, Type.Null()]),
      status: ProposalEvaluationStatusSchemaV1, reasonCode: Reason }, closed),
  ]), { minItems: 1, maxItems: PROPOSAL_GRAPH_LIMITS.batchMembers }),
}, closed);
export type ProposalReviewSummaryResponseV1 = Static<typeof ProposalReviewSummaryResponseSchemaV1>;

function invalid(): never {
  throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.invalidRequest, 'The review summary contract is invalid.');
}
export function parseProposalReviewSummaryRequestV1(value: unknown): ProposalReviewSummaryRequestV1 {
  if (!Value.Check(ProposalReviewSummaryRequestSchemaV1, value)) invalid();
  return value as ProposalReviewSummaryRequestV1;
}
export function parseProposalReviewSummaryResponseV1(value: unknown): ProposalReviewSummaryResponseV1 {
  if (!Value.Check(ProposalReviewSummaryResponseSchemaV1, value)) invalid();
  const result = value as ProposalReviewSummaryResponseV1;
  if (new Set(result.items.map(item => item.operationId)).size !== result.items.length
    || result.items.some(item => item.mode === 'graph' && (item.proposal && item.proposal.operationId !== item.operationId
      || !item.proposal && item.reasonCode === null
      || ['clean', 'clean_rebased', 'empty_effect', 'satisfied_elsewhere'].includes(item.status)
        && (!result.current || result.graphRevision === null)))) invalid();
  return result;
}
