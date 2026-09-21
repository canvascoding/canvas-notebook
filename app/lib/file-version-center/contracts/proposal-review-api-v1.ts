import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { PROPOSAL_GRAPH_LIMITS } from './proposal-graph-v1';
import { FILE_VERSION_CENTER_ERROR_CODES, FileVersionCenterContractError } from './v1';

export const PROPOSAL_REVIEW_API_CONTRACT_VERSION = 1 as const;
const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' });
const Cursor = Type.String({ minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9._~+/=-]{1,256}$' });
const Target = Type.Object({ kind: Type.Literal('document'), workspaceId: Id, documentId: Id, lineageId: Id }, { additionalProperties: false });
export const ProposalReviewProjectionRequestSchemaV1 = Type.Object({
  contractVersion: Type.Literal(PROPOSAL_REVIEW_API_CONTRACT_VERSION), target: Target,
  rootProposalId: Id, selectedProposalIds: Type.Array(Id, { minItems: 0, maxItems: PROPOSAL_GRAPH_LIMITS.batchMembers, uniqueItems: true }),
  cursor: Type.Optional(Cursor), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })),
}, { additionalProperties: false });
export type ProposalReviewProjectionRequestV1 = Static<typeof ProposalReviewProjectionRequestSchemaV1>;

export function parseProposalReviewProjectionRequestV1(value: unknown): ProposalReviewProjectionRequestV1 {
  if (!Value.Check(ProposalReviewProjectionRequestSchemaV1, value)) {
    throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.invalidRequest, 'The proposal review request is invalid.');
  }
  return value as ProposalReviewProjectionRequestV1;
}
