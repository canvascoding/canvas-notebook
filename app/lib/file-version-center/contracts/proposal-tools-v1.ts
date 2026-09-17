import { Type, type Static } from 'typebox';

import {
  PROPOSAL_GRAPH_ERROR_CODES as Codes,
  ProposalDocumentScopeSchemaV1, ProposalRelationshipsSchemaV1, ProposalSourceProofSchemaV1,
  ProposalGraphContractError, assertProposalGraphContractV1,
  type ProposalSourceProofV1,
} from './proposal-graph-v1';

export const PROPOSAL_TOOLS_CONTRACT_VERSION = 1 as const;
const closed = { additionalProperties: false } as const;
const Version = Type.Literal(PROPOSAL_TOOLS_CONTRACT_VERSION);
const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' });
const Hash = Type.String({ minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' });
const Cas = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const CreationKind = Type.Union([Type.Literal('independent'), Type.Literal('extends'), Type.Literal('replacement')]);

const ReferencedProposal = Type.Object({
  proposalId: Id, expectedCasVersion: Cas, expectedCandidateHash: Hash,
}, closed);

/** Selection is explicit: an absent/unknown proposal never means "latest proposal". */
export const ProposalToolReadRequestSchemaV1 = Type.Object({
  contractVersion: Version,
  proposalId: Type.Union([Id, Type.Null()], { description: 'Exact proposal ID, or null for the authoritative document. No implicit latest proposal.' }),
  expectedScope: Type.Optional(ProposalDocumentScopeSchemaV1),
}, closed);
export type ProposalToolReadRequestV1 = Static<typeof ProposalToolReadRequestSchemaV1>;

/** Returned beside the bounded text/structure page. Source always covers the complete candidate. */
export const ProposalToolReadResultSchemaV1 = Type.Object({
  contractVersion: Version,
  source: ProposalSourceProofSchemaV1,
  contentSha256: Hash,
  graphRevision: Revision,
}, closed);
export type ProposalToolReadResultV1 = Static<typeof ProposalToolReadResultSchemaV1>;

/**
 * Copy the full server-issued source from an explicit proposal read. All values
 * remain untrusted input: the service reauthorizes the path/scope and verifies
 * every immutable artifact, parent/evaluation and CAS before creating anything.
 * Caller-supplied Yjs updates, implicit dependencies and Safe-Direct are excluded.
 */
export const ProposalToolEditSchemaV1 = Type.Object({
  contractVersion: Version,
  creationKind: CreationKind,
  source: ProposalSourceProofSchemaV1,
  expectedParentCandidateHash: Type.Union([Hash, Type.Null()]),
  expectedParentCasVersion: Type.Union([Cas, Type.Null()]),
  replaces: Type.Union([ReferencedProposal, Type.Null()]),
  choice: Type.Union([
    Type.Object({ kind: Type.Literal('existing'), groupId: Id, expectedGroupRevision: Revision }, closed),
    Type.Object({ kind: Type.Literal('alternative_to'), ...ReferencedProposal.properties }, closed),
    Type.Null(),
  ]),
}, {
  ...closed,
  description: 'Explicit review-required proposal provenance. Copy source from read with a proposal selector; never infer a parent from chat text. Missing or stale declared references are errors, never independent edits.',
});
export type ProposalToolEditV1 = Static<typeof ProposalToolEditSchemaV1>;

/**
 * Immutable creation/retry receipt, not evidence of today's proposal lifecycle.
 * Refresh the exact proposal ID before notifying or exposing current actions.
 * source is the original authoring base, NOT a source for editing the new proposal.
 */
export const ProposalToolCreationResultSchemaV1 = Type.Object({
  contractVersion: Version,
  proposalId: Id,
  operationId: Id,
  scope: ProposalDocumentScopeSchemaV1,
  creationKind: CreationKind,
  casVersion: Cas,
  candidateHash: Hash,
  source: ProposalSourceProofSchemaV1,
  relationships: ProposalRelationshipsSchemaV1,
  reviewRequired: Type.Literal(true),
}, closed);
export type ProposalToolCreationResultV1 = Static<typeof ProposalToolCreationResultSchemaV1>;

function fail(code: typeof Codes[keyof typeof Codes], message: string): never {
  throw new ProposalGraphContractError(code, message);
}

function validateSource(source: ProposalSourceProofV1): void {
  if (source.kind === 'proposal' && (source.snapshot.sha256 !== source.candidateHash
    || (source.evaluationId === null && source.candidateHash !== source.authoredCandidateHash))) {
    fail(Codes.sourceInvalid, 'Proposal source must identify its exact authored or evaluated candidate.');
  }
}

export function parseProposalToolReadRequestV1(value: unknown): ProposalToolReadRequestV1 {
  assertProposalGraphContractV1(ProposalToolReadRequestSchemaV1, value);
  return value;
}

export function parseProposalToolReadResultV1(value: unknown): ProposalToolReadResultV1 {
  assertProposalGraphContractV1(ProposalToolReadResultSchemaV1, value);
  validateSource(value.source);
  return value;
}

export function parseProposalToolEditV1(value: unknown): ProposalToolEditV1 {
  assertProposalGraphContractV1(ProposalToolEditSchemaV1, value);
  validateSource(value.source);
  const { source, creationKind, replaces, choice } = value;
  if (source.kind === 'proposal') {
    if (value.expectedParentCasVersion !== source.proposalCasVersion
      || value.expectedParentCandidateHash !== source.candidateHash) {
      fail(Codes.parentChanged, 'Expected parent CAS and candidate hash must match the explicit read source.');
    }
    if (replaces?.proposalId === source.proposalId || (choice?.kind === 'alternative_to' && choice.proposalId === source.proposalId)) {
      fail(Codes.sourceInvalid, 'A replacement or alternative retains the original prerequisite, not the replaced or competing proposal.');
    }
  } else if (value.expectedParentCasVersion !== null || value.expectedParentCandidateHash !== null) {
    fail(Codes.sourceInvalid, 'An authoritative source cannot declare a parent guard.');
  }
  if ((creationKind === 'independent' && source.kind !== 'authoritative')
    || (creationKind === 'extends' && source.kind !== 'proposal')
    || ((creationKind === 'replacement') !== (replaces !== null))) {
    fail(Codes.sourceInvalid, 'Creation kind does not match its explicit source and replacement relationship.');
  }
  return value;
}

export function parseProposalToolCreationResultV1(value: unknown): ProposalToolCreationResultV1 {
  assertProposalGraphContractV1(ProposalToolCreationResultSchemaV1, value);
  validateSource(value.source);
  const { source, relationships } = value;
  if (Object.keys(value.scope).some((key) => value.scope[key as keyof typeof value.scope] !== source.scope[key as keyof typeof value.scope])) {
    fail(Codes.scopeMismatch, 'Proposal result and authoring source have different document scopes.');
  }
  if (relationships.dependency?.proposalId === value.proposalId || relationships.replacesProposalId === value.proposalId) {
    fail(Codes.cycle, 'A proposal result cannot depend on or replace itself.');
  }
  if (source.kind === 'proposal' ? relationships.dependency?.proposalId !== source.proposalId
    || relationships.dependency.candidateHash !== source.authoredCandidateHash
    || relationships.replacesProposalId === source.proposalId : relationships.dependency !== null) {
    fail(Codes.sourceInvalid, 'Proposal result relationships do not match its authoring source.');
  }
  if ((value.creationKind === 'independent' && source.kind !== 'authoritative')
    || (value.creationKind === 'extends' && source.kind !== 'proposal')
    || ((value.creationKind === 'replacement') !== (relationships.replacesProposalId !== null))) {
    fail(Codes.sourceInvalid, 'Proposal result creation kind does not match its relationships.');
  }
  return value;
}

/** Presence is deliberate: null, undefined or malformed declarations must never fall back. */
export function parseOptionalProposalToolEditV1(input: Record<string, unknown>): ProposalToolEditV1 | undefined {
  return Object.hasOwn(input, 'proposal') ? parseProposalToolEditV1(input.proposal) : undefined;
}
