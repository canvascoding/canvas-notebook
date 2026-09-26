import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { FileVersionCenterContractError, FILE_VERSION_CENTER_ERROR_CODES, FileVersionCenterTargetSchemaV1 } from './v1';
import { PROPOSAL_GRAPH_LIMITS, ProposalActionFenceSchemaV1, ProposalCreateRequestSchemaV1 } from './proposal-graph-v1';

const closed = { additionalProperties: false } as const;
const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' });
const Hash = Type.String({ minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' });
const Kind = Type.Union([Type.Literal('detach'), Type.Literal('replace')]);

export const ProposalReviewTransformRequestSchemaV1 = Type.Object({
  contractVersion: Type.Literal(1),
  target: FileVersionCenterTargetSchemaV1,
  sourceProposalId: Id,
  kind: Kind,
  expectedGraphRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
}, closed);
export type ProposalReviewTransformRequestV1 = Static<typeof ProposalReviewTransformRequestSchemaV1>;

export const ProposalReviewTransformResponseSchemaV1 = Type.Object({
  contractVersion: Type.Literal(1),
  kind: Kind,
  sourceProposalId: Id,
  beforeContent: Type.String({ maxLength: PROPOSAL_GRAPH_LIMITS.candidateBytes }),
  proposedContent: Type.String({ maxLength: PROPOSAL_GRAPH_LIMITS.candidateBytes }),
  beforeSha256: Hash,
  proposedSha256: Hash,
  prepared: Type.Object({ fence: ProposalActionFenceSchemaV1,
    fenceToken: Type.String({ pattern: '^pg1\\.[A-Za-z0-9_-]{43}$' }),
    creation: ProposalCreateRequestSchemaV1 }, closed),
}, closed);
export type ProposalReviewTransformResponseV1 = Static<typeof ProposalReviewTransformResponseSchemaV1>;

function invalid(): never {
  throw new FileVersionCenterContractError(FILE_VERSION_CENTER_ERROR_CODES.invalidRequest, 'The proposal transformation contract is invalid.');
}
export function parseProposalReviewTransformRequestV1(value: unknown): ProposalReviewTransformRequestV1 {
  if (!Value.Check(ProposalReviewTransformRequestSchemaV1, value)) invalid();
  return value as ProposalReviewTransformRequestV1;
}
export function parseProposalReviewTransformResponseV1(value: unknown): ProposalReviewTransformResponseV1 {
  if (!Value.Check(ProposalReviewTransformResponseSchemaV1, value)) invalid();
  return value as ProposalReviewTransformResponseV1;
}
