import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { ProposalEvaluationStatusSchemaV1, ProposalLifecycleSchemaV1 } from './proposal-graph-v1';

const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' });
const closed = { additionalProperties: false };

/** Content-free current annotation; never replaces a stored historical operation reference. */
export const ProposalEntryPointSchemaV1 = Type.Object({
  contractVersion: Type.Literal(1),
  proposalId: Id,
  rootProposalId: Id,
  lineageId: Id,
  graphRevision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  lifecycle: ProposalLifecycleSchemaV1,
  status: ProposalEvaluationStatusSchemaV1,
  successors: Type.Array(Type.Object({
    proposalId: Id,
    operationId: Id,
    relation: Type.Union([Type.Literal('extends'), Type.Literal('replaces')]),
    lifecycle: ProposalLifecycleSchemaV1,
  }, closed), { maxItems: 32 }),
  moreSuccessors: Type.Boolean(),
}, closed);

export type ProposalEntryPointV1 = Static<typeof ProposalEntryPointSchemaV1>;

export function parseProposalEntryPointV1(value: unknown): ProposalEntryPointV1 {
  if (!Value.Check(ProposalEntryPointSchemaV1, value)) throw new Error('Invalid proposal entry-point annotation.');
  const result = value as ProposalEntryPointV1;
  if (new Set(result.successors.map(item => item.proposalId)).size !== result.successors.length
    || new Set(result.successors.map(item => item.operationId)).size !== result.successors.length
    || result.successors.some(item => item.proposalId === result.proposalId)) {
    throw new Error('Invalid proposal successor references.');
  }
  return result;
}
