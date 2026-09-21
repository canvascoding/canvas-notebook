import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { FILE_VERSION_CENTER_ERROR_CODES, FileVersionCenterContractError } from './v1';

const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' });
const Hash = Type.String({ minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' });
const Proof = Type.Object({ revisionId: Type.Union([Id, Type.Null()]), contentHash: Hash, structureHash: Hash,
  stateVectorHash: Hash, deleteSetHash: Hash, fullStateHash: Hash }, { additionalProperties: false });
const Target = Type.Object({ kind: Type.Literal('document'), workspaceId: Id, documentId: Id, lineageId: Id }, { additionalProperties: false });
const Binding = Type.Object({ evaluationId: Id, selectionHash: Hash, selectedProposalIds: Type.Array(Id, { minItems: 1, maxItems: 32, uniqueItems: true }),
  current: Proof, graphRevision: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });

/** Transport-only request; candidate bytes and storage references never cross this boundary. */
export const ProposalReviewCompareApiRequestSchemaV1 = Type.Object({
  contractVersion: Type.Literal(1), target: Target, selectedProposalIds: Type.Array(Id, { minItems: 1, maxItems: 32, uniqueItems: true }),
  binding: Type.Optional(Binding), cursor: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
}, { additionalProperties: false });
export type ProposalReviewCompareApiRequestV1 = Static<typeof ProposalReviewCompareApiRequestSchemaV1>;

export function parseProposalReviewCompareApiRequestV1(value: unknown): ProposalReviewCompareApiRequestV1 {
  if (!Value.Check(ProposalReviewCompareApiRequestSchemaV1, value)) {
    throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.invalidRequest, 'The proposal comparison request is invalid.');
  }
  return value as ProposalReviewCompareApiRequestV1;
}
