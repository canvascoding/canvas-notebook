import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

/** New contracts are inert until graph-aware persistence and mutation routes are enabled. */
export const PROPOSAL_GRAPH_CONTRACT_VERSION = 1 as const;

export const PROPOSAL_GRAPH_LIMITS = Object.freeze({
  payloadBytes: 1_024 * 1_024,
  candidateBytes: 8 * 1_024 * 1_024,
  artifactBytesPerGraph: 128 * 1_024 * 1_024,
  artifactsPerGraph: 4_096,
  nodesPerSnapshot: 256,
  nodesPerRoot: 128,
  dependencyDepth: 16,
  openRootsPerDocument: 32,
  closureNodes: 128,
  batchMembers: 32,
  choiceGroups: 128,
  legacyTargets: 1_024,
  fenceLifetimeMs: 15 * 60 * 1_000,
} as const);

export const PROPOSAL_GRAPH_ERROR_CODES = Object.freeze({
  invalidRequest: 'PROPOSAL_INVALID_REQUEST',
  unsupportedVersion: 'PROPOSAL_UNSUPPORTED_VERSION',
  limitExceeded: 'PROPOSAL_LIMIT_EXCEEDED',
  scopeMismatch: 'PROPOSAL_SCOPE_MISMATCH',
  sourceInvalid: 'PROPOSAL_SOURCE_INVALID',
  parentChanged: 'PROPOSAL_PARENT_CHANGED',
  cycle: 'PROPOSAL_CYCLE',
  dependencyBlocked: 'PROPOSAL_DEPENDENCY_BLOCKED',
  prerequisiteLost: 'PROPOSAL_PREREQUISITE_LOST',
  graphChanged: 'PROPOSAL_GRAPH_CHANGED',
  currentChanged: 'PROPOSAL_CURRENT_CHANGED',
  candidateChanged: 'PROPOSAL_CANDIDATE_CHANGED',
  choiceConflict: 'PROPOSAL_CHOICE_CONFLICT',
  batchConflict: 'PROPOSAL_BATCH_CONFLICT',
  staleLifecycle: 'PROPOSAL_STALE_LIFECYCLE',
  contentUnavailable: 'PROPOSAL_CONTENT_UNAVAILABLE',
  accessDenied: 'PROPOSAL_ACCESS_DENIED',
  fenceExpired: 'PROPOSAL_FENCE_EXPIRED',
  invalidTransition: 'PROPOSAL_INVALID_TRANSITION',
  idempotencyMismatch: 'PROPOSAL_IDEMPOTENCY_MISMATCH',
  recoveryRequired: 'PROPOSAL_RECOVERY_REQUIRED',
  noEffect: 'PROPOSAL_NO_EFFECT',
  legacyBlocked: 'PROPOSAL_LEGACY_BLOCKED',
  upgradeRequired: 'PROPOSAL_UPGRADE_REQUIRED',
} as const);

export type ProposalGraphErrorCode = typeof PROPOSAL_GRAPH_ERROR_CODES[keyof typeof PROPOSAL_GRAPH_ERROR_CODES];

export class ProposalGraphContractError extends Error {
  constructor(readonly code: ProposalGraphErrorCode, message: string) {
    super(message);
    this.name = 'ProposalGraphContractError';
  }
}

const Version = Type.Literal(PROPOSAL_GRAPH_CONTRACT_VERSION);
const Id = Type.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' });
const Hash = Type.String({ minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' });
const NullableId = Type.Union([Id, Type.Null()]);
const Counter = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Generation = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const Timestamp = Counter;
// Preserve a literal tuple: a mapped array erases TypeBox's static union to never.
const ErrorCode = Type.Union([
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.invalidRequest),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.unsupportedVersion),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.limitExceeded),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.scopeMismatch),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.sourceInvalid),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.parentChanged),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.cycle),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.dependencyBlocked),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.prerequisiteLost),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.graphChanged),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.currentChanged),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.candidateChanged),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.choiceConflict),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.batchConflict),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.staleLifecycle),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.contentUnavailable),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.accessDenied),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.fenceExpired),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.invalidTransition),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.idempotencyMismatch),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.recoveryRequired),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.noEffect),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.legacyBlocked),
  Type.Literal(PROPOSAL_GRAPH_ERROR_CODES.upgradeRequired),
]);
const closed = { additionalProperties: false } as const;

/** Path is intentionally absent: rename cannot retarget a proposal to another file. */
export const ProposalDocumentScopeSchemaV1 = Type.Object({
  workspaceId: Id,
  lineageId: Id,
  documentId: Id,
  lifecycleGeneration: Generation,
  schemaVersion: Generation,
}, closed);
export type ProposalDocumentScopeV1 = Static<typeof ProposalDocumentScopeSchemaV1>;

/** All hashes are SHA-256 digests. State vector alone does not prove deletion state. */
export const ProposalCurrentProofSchemaV1 = Type.Object({
  revisionId: NullableId,
  contentHash: Hash,
  structureHash: Hash,
  stateVectorHash: Hash,
  deleteSetHash: Hash,
  fullStateHash: Hash,
}, closed);
export type ProposalCurrentProofV1 = Static<typeof ProposalCurrentProofSchemaV1>;

/** ref is an opaque authorized storage identifier, never a path, URL, token or payload. */
export const ProposalArtifactReferenceSchemaV1 = Type.Object({
  ref: Id,
  sha256: Hash,
  sizeBytes: Type.Integer({ minimum: 0, maximum: PROPOSAL_GRAPH_LIMITS.candidateBytes }),
}, closed);
export type ProposalArtifactReferenceV1 = Static<typeof ProposalArtifactReferenceSchemaV1>;

/** Full Yjs update preserves authored IDs; a Yjs snapshot/state vector is insufficient. */
export const ProposalSnapshotReferenceSchemaV1 = Type.Object({
  ...ProposalArtifactReferenceSchemaV1.properties,
  encoding: Type.Literal('yjs_full_update_v1'),
}, closed);
export type ProposalSnapshotReferenceV1 = Static<typeof ProposalSnapshotReferenceSchemaV1>;

const sourceFields = {
  scope: ProposalDocumentScopeSchemaV1,
  current: ProposalCurrentProofSchemaV1,
  snapshot: ProposalSnapshotReferenceSchemaV1,
  anchorMap: ProposalArtifactReferenceSchemaV1,
};

/** Authored provenance never changes when a later evaluation rebases the candidate. */
export const ProposalSourceProofSchemaV1 = Type.Union([
  Type.Object({ kind: Type.Literal('authoritative'), ...sourceFields }, closed),
  Type.Object({
    kind: Type.Literal('proposal'),
    ...sourceFields,
    proposalId: Id,
    proposalCasVersion: Generation,
    authoredCandidateHash: Hash,
    evaluationId: NullableId,
    candidateHash: Hash,
  }, closed),
]);
export type ProposalSourceProofV1 = Readonly<Static<typeof ProposalSourceProofSchemaV1>>;

export const ProposalRelationshipsSchemaV1 = Type.Object({
  dependency: Type.Union([
    Type.Object({ proposalId: Id, candidateHash: Hash }, closed),
    Type.Null(),
  ]),
  replacesProposalId: NullableId,
  choiceGroupId: NullableId,
}, closed);
export type ProposalRelationshipsV1 = Static<typeof ProposalRelationshipsSchemaV1>;

export const ProposalAuthoredCandidateSchemaV1 = Type.Object({
  incrementalPayload: ProposalArtifactReferenceSchemaV1,
  cumulativeCandidate: ProposalSnapshotReferenceSchemaV1,
  effectPreconditions: ProposalArtifactReferenceSchemaV1,
  sourceProofHash: Hash,
}, closed);
export type ProposalAuthoredCandidateV1 = Readonly<Static<typeof ProposalAuthoredCandidateSchemaV1>>;

export const ProposalLifecycleSchemaV1 = Type.Union([
  Type.Literal('open'), Type.Literal('applied'), Type.Literal('included'),
  Type.Literal('rejected'), Type.Literal('superseded'), Type.Literal('alternative_not_selected'),
  Type.Literal('satisfied_elsewhere'), Type.Literal('expired'),
]);
export type ProposalLifecycleV1 = Static<typeof ProposalLifecycleSchemaV1>;

export const ProposalEvaluationStatusSchemaV1 = Type.Union([
  Type.Literal('rebase_pending'), Type.Literal('clean'), Type.Literal('clean_rebased'),
  Type.Literal('blocked_by_parent'), Type.Literal('prerequisite_lost'),
  Type.Literal('conflicted'), Type.Literal('stale_lifecycle'), Type.Literal('unavailable'),
  Type.Literal('satisfied_elsewhere'), Type.Literal('empty_effect'),
]);
export type ProposalEvaluationStatusV1 = Static<typeof ProposalEvaluationStatusSchemaV1>;

export const ProposalNodeSchemaV1 = Type.Object({
  contractVersion: Version,
  proposalId: Id,
  operationId: Id,
  scope: ProposalDocumentScopeSchemaV1,
  casVersion: Generation,
  source: ProposalSourceProofSchemaV1,
  relationships: ProposalRelationshipsSchemaV1,
  authoredCandidate: ProposalAuthoredCandidateSchemaV1,
  lifecycle: ProposalLifecycleSchemaV1,
  createdAt: Timestamp,
  createdByActorId: Id,
}, closed);
export type ProposalNodeV1 = Static<typeof ProposalNodeSchemaV1>;

/** Server-prepared immutable creation; references are reauthorized before insertion. */
export const ProposalCreateRequestSchemaV1 = Type.Object({
  contractVersion: Version,
  proposalId: Id,
  operationId: Id,
  scope: ProposalDocumentScopeSchemaV1,
  source: ProposalSourceProofSchemaV1,
  relationships: ProposalRelationshipsSchemaV1,
  authoredCandidate: ProposalAuthoredCandidateSchemaV1,
  creationKind: Type.Union([Type.Literal('independent'), Type.Literal('extends'), Type.Literal('replacement'), Type.Literal('detached')]),
  detachedFromProposalId: NullableId,
  reviewRequired: Type.Literal(true),
}, closed);
export type ProposalCreateRequestV1 = Static<typeof ProposalCreateRequestSchemaV1>;

export const ProposalEvaluationSchemaV1 = Type.Object({
  contractVersion: Version,
  evaluationId: Id,
  proposalId: Id,
  scope: ProposalDocumentScopeSchemaV1,
  current: ProposalCurrentProofSchemaV1,
  graphRevision: Counter,
  status: ProposalEvaluationStatusSchemaV1,
  reasonCode: Type.Union([ErrorCode, Type.Null()]),
  effectiveCandidate: Type.Union([ProposalSnapshotReferenceSchemaV1, Type.Null()]),
  anchorMap: Type.Union([ProposalArtifactReferenceSchemaV1, Type.Null()]),
  effectPreconditions: Type.Union([ProposalArtifactReferenceSchemaV1, Type.Null()]),
  evaluatedAt: Timestamp,
  expiresAt: Timestamp,
}, closed);
export type ProposalEvaluationV1 = Static<typeof ProposalEvaluationSchemaV1>;

export const ProposalActionTypeSchemaV1 = Type.Union([
  Type.Literal('accept'), Type.Literal('batch_accept'), Type.Literal('reject'),
  Type.Literal('branch_reject'), Type.Literal('replace'), Type.Literal('detach'),
  Type.Literal('rebase'), Type.Literal('complete_satisfied'),
]);
export type ProposalActionTypeV1 = Static<typeof ProposalActionTypeSchemaV1>;

export const ProposalClosureMemberSchemaV1 = Type.Object({
  proposalId: Id,
  casVersion: Generation,
  candidateHash: Hash,
}, closed);
export type ProposalClosureMemberV1 = Static<typeof ProposalClosureMemberSchemaV1>;

const ProposalIds = Type.Array(Id, { maxItems: PROPOSAL_GRAPH_LIMITS.closureNodes, uniqueItems: true });
const Selection = Type.Array(Id, { minItems: 1, maxItems: PROPOSAL_GRAPH_LIMITS.batchMembers, uniqueItems: true });
const ChoiceResolution = Type.Object({
  groupId: Id,
  groupRevision: Counter,
  chosenProposalId: Id,
  closingProposalIds: ProposalIds,
}, closed);

/** Server-authenticated context; possession of these fields is never authorization. */
export const ProposalActionFenceSchemaV1 = Type.Object({
  contractVersion: Version,
  fenceId: Id,
  scope: ProposalDocumentScopeSchemaV1,
  actor: Type.Object({ userId: Id, actorId: Id, authorizationRevision: Id }, closed),
  actionType: ProposalActionTypeSchemaV1,
  current: Type.Union([ProposalCurrentProofSchemaV1, Type.Null()]),
  graphRevision: Counter,
  evaluationId: NullableId,
  effectiveCandidateHash: Type.Union([Hash, Type.Null()]),
  closure: Type.Array(ProposalClosureMemberSchemaV1, {
    minItems: 1, maxItems: PROPOSAL_GRAPH_LIMITS.closureNodes,
  }),
  closureHash: Hash,
  selectedProposalIds: Selection,
  applyProposalIds: ProposalIds,
  batchHash: Hash,
  choiceResolutions: Type.Array(ChoiceResolution, { maxItems: PROPOSAL_GRAPH_LIMITS.choiceGroups }),
  requestDigest: Hash,
  issuedAt: Timestamp,
  expiresAt: Timestamp,
}, closed);
export type ProposalActionFenceV1 = Static<typeof ProposalActionFenceSchemaV1>;

/** Transport-only approval token: omit it from URLs, telemetry and durable receipts. */
export const ProposalActionRequestSchemaV1 = Type.Object({
  contractVersion: Version,
  fence: ProposalActionFenceSchemaV1,
  fenceToken: Type.String({ minLength: 32, maxLength: 2_048, pattern: '^[A-Za-z0-9_.-]+$' }),
  idempotencyKey: Type.String({ minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' }),
  creation: Type.Union([ProposalCreateRequestSchemaV1, Type.Null()]),
}, closed);
export type ProposalActionRequestV1 = Static<typeof ProposalActionRequestSchemaV1>;

const Resolution = Type.Object({
  proposalId: Id,
  lifecycle: Type.Union([
    Type.Literal('applied'), Type.Literal('included'), Type.Literal('rejected'),
    Type.Literal('superseded'), Type.Literal('alternative_not_selected'),
    Type.Literal('satisfied_elsewhere'), Type.Literal('expired'),
  ]),
}, closed);

export const ProposalActionResultSchemaV1 = Type.Union([
  Type.Object({
    kind: Type.Literal('content_changed'),
    revisionId: Id,
    current: ProposalCurrentProofSchemaV1,
    createdProposalIds: Type.Array(Id, { maxItems: 0 }),
    resolutions: Type.Array(Resolution, { minItems: 1, maxItems: PROPOSAL_GRAPH_LIMITS.closureNodes }),
  }, closed),
  Type.Object({
    kind: Type.Literal('metadata_only'),
    revisionId: Type.Null(),
    current: Type.Union([ProposalCurrentProofSchemaV1, Type.Null()]),
    createdProposalIds: Type.Array(Id, { maxItems: 1 }),
    resolutions: Type.Array(Resolution, { maxItems: PROPOSAL_GRAPH_LIMITS.closureNodes }),
  }, closed),
]);
export type ProposalActionResultV1 = Static<typeof ProposalActionResultSchemaV1>;

export const ProposalReceiptPhaseSchemaV1 = Type.Union([
  Type.Literal('prepared'), Type.Literal('applying'), Type.Literal('awaiting_durability'),
  Type.Literal('recovery_required'), Type.Literal('succeeded'), Type.Literal('failed'),
]);
export type ProposalReceiptPhaseV1 = Static<typeof ProposalReceiptPhaseSchemaV1>;

const receiptFields = {
  contractVersion: Version,
  actionId: Id,
  scope: ProposalDocumentScopeSchemaV1,
  actorId: Id,
  actionType: ProposalActionTypeSchemaV1,
  requestDigest: Hash,
  idempotencyKeyHash: Hash,
  affectedProposalIds: ProposalIds,
  operationId: NullableId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
};

/** Operation durability remains authoritative; receipt links it instead of copying its truth. */
export const ProposalActionReceiptSchemaV1 = Type.Union([
  Type.Object({
    ...receiptFields,
    phase: Type.Union([
      Type.Literal('prepared'), Type.Literal('applying'),
      Type.Literal('awaiting_durability'), Type.Literal('recovery_required'),
    ]),
    result: Type.Null(),
    errorCode: Type.Union([ErrorCode, Type.Null()]),
  }, closed),
  Type.Object({ ...receiptFields, phase: Type.Literal('succeeded'), result: ProposalActionResultSchemaV1, errorCode: Type.Null() }, closed),
  Type.Object({ ...receiptFields, phase: Type.Literal('failed'), result: Type.Null(), errorCode: ErrorCode }, closed),
]);
export type ProposalActionReceiptV1 = Static<typeof ProposalActionReceiptSchemaV1>;

export const ProposalChoiceGroupSchemaV1 = Type.Object({
  groupId: Id,
  groupRevision: Counter,
  dependencyProposalId: NullableId,
  memberProposalIds: Type.Array(Id, { minItems: 1, maxItems: PROPOSAL_GRAPH_LIMITS.nodesPerRoot, uniqueItems: true }),
  archivedMemberCount: Type.Optional(Counter),
  chosenProposalId: NullableId,
}, closed);
export type ProposalChoiceGroupV1 = Static<typeof ProposalChoiceGroupSchemaV1>;

/** Complete bounded validation context, not a paginated timeline response. */
export const ProposalGraphSnapshotSchemaV1 = Type.Object({
  contractVersion: Version,
  scope: ProposalDocumentScopeSchemaV1,
  graphRevision: Counter,
  nodes: Type.Array(ProposalNodeSchemaV1, { maxItems: PROPOSAL_GRAPH_LIMITS.nodesPerSnapshot }),
  choiceGroups: Type.Array(ProposalChoiceGroupSchemaV1, { maxItems: PROPOSAL_GRAPH_LIMITS.choiceGroups }),
  archivedReplacementProposalIds: Type.Optional(Type.Array(Id, { maxItems: PROPOSAL_GRAPH_LIMITS.nodesPerSnapshot, uniqueItems: true })),
}, closed);
export type ProposalGraphSnapshotV1 = Static<typeof ProposalGraphSnapshotSchemaV1>;

export const ProposalLegacyEvidenceSchemaV1 = Type.Object({
  contractVersion: Version,
  operationId: Id,
  scope: ProposalDocumentScopeSchemaV1,
  operationStatus: Type.Union([
    Type.Literal('preparing'), Type.Literal('ready'), Type.Literal('applying'), Type.Literal('needs_review'),
    Type.Literal('partially_applied'), Type.Literal('semantic_conflict'), Type.Literal('applied_to_ydoc'),
    Type.Literal('persisted_yjs'), Type.Literal('checkpointed_file'), Type.Literal('rejected'),
    Type.Literal('reverted'), Type.Literal('cancel_requested'), Type.Literal('cancelled'),
    Type.Literal('superseded'), Type.Literal('expired'), Type.Literal('failed'),
  ]),
  recoveryStatus: Type.Union([Type.Literal('settled'), Type.Literal('uncertain')]),
  provenance: Type.Union([Type.Literal('verified_authoritative'), Type.Literal('proposal_based'), Type.Literal('unknown')]),
  appliedScope: Type.Union([Type.Literal('none'), Type.Literal('partial'), Type.Literal('all'), Type.Literal('unknown')]),
  relationshipKnowledge: Type.Union([Type.Literal('independent'), Type.Literal('graph_bound'), Type.Literal('unknown')]),
  source: Type.Union([ProposalSourceProofSchemaV1, Type.Null()]),
  originalPayloadHash: Hash,
  appliedPayloadHash: Type.Union([Hash, Type.Null()]),
  remainingPayload: Type.Union([ProposalArtifactReferenceSchemaV1, Type.Null()]),
  targetScope: Type.Object({
    proof: Type.Union([Type.Literal('verified'), Type.Literal('uncertain')]),
    originalTargetIds: Type.Array(Id, { maxItems: PROPOSAL_GRAPH_LIMITS.legacyTargets, uniqueItems: true }),
    appliedTargetIds: Type.Array(Id, { maxItems: PROPOSAL_GRAPH_LIMITS.legacyTargets, uniqueItems: true }),
    pendingTargetIds: Type.Array(Id, { maxItems: PROPOSAL_GRAPH_LIMITS.legacyTargets, uniqueItems: true }),
  }, closed),
}, closed);
export type ProposalLegacyEvidenceV1 = Static<typeof ProposalLegacyEvidenceSchemaV1>;

export const ProposalLegacyProjectionSchemaV1 = Type.Object({
  contractVersion: Version,
  status: Type.Union([Type.Literal('safe_independent'), Type.Literal('blocked')]),
  reason: Type.Union([
    Type.Null(), Type.Literal('unknown_origin'), Type.Literal('partial_operation'),
    Type.Literal('already_resolved'), Type.Literal('graph_bound'), Type.Literal('missing_evidence'), Type.Literal('recovery_uncertain'),
  ]),
  reviewRequired: Type.Literal(true),
  evidence: ProposalLegacyEvidenceSchemaV1,
}, closed);
export type ProposalLegacyProjectionV1 = Static<typeof ProposalLegacyProjectionSchemaV1>;

/** Product effects; the orchestrator must additionally authorize and verify each fence. */
export const PROPOSAL_ACTION_RULES_V1 = Object.freeze({
  accept: { from: ['open'], evaluation: ['clean', 'clean_rebased'], resolution: 'applied', writesContent: true, createsProposal: false, includesDependencies: true, closesAlternatives: true },
  batch_accept: { from: ['open'], evaluation: ['clean', 'clean_rebased'], resolution: 'applied', writesContent: true, createsProposal: false, includesDependencies: true, closesAlternatives: true },
  reject: { from: ['open'], evaluation: 'any', resolution: 'rejected', writesContent: false, createsProposal: false, includesDependencies: false, closesAlternatives: false },
  branch_reject: { from: ['open'], evaluation: 'any', resolution: 'rejected', writesContent: false, createsProposal: false, includesDependencies: false, closesAlternatives: false },
  replace: { from: ['open'], evaluation: 'any', resolution: 'superseded', writesContent: false, createsProposal: true, includesDependencies: false, closesAlternatives: false },
  detach: { from: ['open'], evaluation: 'any', resolution: null, writesContent: false, createsProposal: true, includesDependencies: false, closesAlternatives: false },
  rebase: { from: ['open'], evaluation: 'any', resolution: null, writesContent: false, createsProposal: false, includesDependencies: false, closesAlternatives: false },
  complete_satisfied: { from: ['open'], evaluation: ['satisfied_elsewhere'], resolution: 'satisfied_elsewhere', writesContent: false, createsProposal: false, includesDependencies: false, closesAlternatives: false },
} as const);

/** Historical resolution alone never proves that today's prerequisite remains present. */
export const PROPOSAL_PREREQUISITE_RULES_V1 = Object.freeze({
  open: 'include_after_review',
  applied: 'verify_current_effect',
  included: 'verify_current_effect',
  satisfied_elsewhere: 'verify_current_effect_and_choice',
  rejected: 'blocked',
  superseded: 'blocked',
  alternative_not_selected: 'blocked',
  expired: 'blocked',
} as const);

/** included is an internal durable chain outcome, never a standalone user mutation. */
export function canTransitionProposalLifecycleV1(from: ProposalLifecycleV1, to: ProposalLifecycleV1): boolean {
  return from === to || from === 'open';
}

const receiptTransitions: Record<ProposalReceiptPhaseV1, readonly ProposalReceiptPhaseV1[]> = {
  prepared: ['applying', 'succeeded', 'failed'],
  applying: ['awaiting_durability', 'recovery_required'],
  awaiting_durability: ['succeeded', 'recovery_required'],
  recovery_required: ['awaiting_durability', 'succeeded', 'failed'],
  succeeded: [],
  failed: [],
};

/** Recovery -> failed requires authoritative proof that no live/durable apply occurred. */
export function canTransitionProposalReceiptV1(from: ProposalReceiptPhaseV1, to: ProposalReceiptPhaseV1): boolean {
  return from === to || receiptTransitions[from].includes(to);
}

function fail(code: ProposalGraphErrorCode, message: string): never {
  throw new ProposalGraphContractError(code, message);
}

/** Validation only. Hash authenticity, current authorization and blob existence are server checks. */
export function assertProposalGraphContractV1<T extends TSchema>(schema: T, value: unknown): asserts value is Static<T> {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); } catch {
    fail(PROPOSAL_GRAPH_ERROR_CODES.invalidRequest, 'Proposal contract requires JSON data.');
  }
  if (serialized === undefined) fail(PROPOSAL_GRAPH_ERROR_CODES.invalidRequest, 'Proposal contract requires JSON data.');
  if (new TextEncoder().encode(serialized).byteLength > PROPOSAL_GRAPH_LIMITS.payloadBytes) {
    fail(PROPOSAL_GRAPH_ERROR_CODES.limitExceeded, 'Proposal contract payload limit exceeded.');
  }
  if (!Value.Check(schema, value)) {
    const version = value && typeof value === 'object' ? (value as { contractVersion?: unknown }).contractVersion : undefined;
    fail(version !== undefined && version !== PROPOSAL_GRAPH_CONTRACT_VERSION
      ? PROPOSAL_GRAPH_ERROR_CODES.unsupportedVersion : PROPOSAL_GRAPH_ERROR_CODES.invalidRequest,
    'Proposal payload does not match contract version 1.');
  }
}

function sameScope(left: ProposalDocumentScopeV1, right: ProposalDocumentScopeV1): boolean {
  return left.workspaceId === right.workspaceId && left.lineageId === right.lineageId
    && left.documentId === right.documentId && left.lifecycleGeneration === right.lifecycleGeneration
    && left.schemaVersion === right.schemaVersion;
}

export function parseProposalNodeV1(value: unknown): ProposalNodeV1 {
  assertProposalGraphContractV1(ProposalNodeSchemaV1, value);
  if (!sameScope(value.scope, value.source.scope)) fail(PROPOSAL_GRAPH_ERROR_CODES.scopeMismatch, 'Source belongs to a different document scope.');
  const { dependency, replacesProposalId } = value.relationships;
  if (dependency?.proposalId === value.proposalId || replacesProposalId === value.proposalId) {
    fail(PROPOSAL_GRAPH_ERROR_CODES.cycle, 'A proposal cannot depend on or replace itself.');
  }
  if (value.source.kind === 'proposal') {
    if (dependency?.proposalId !== value.source.proposalId || dependency.candidateHash !== value.source.authoredCandidateHash
      || (value.source.evaluationId === null && value.source.candidateHash !== value.source.authoredCandidateHash)
      || value.source.snapshot.sha256 !== value.source.candidateHash) {
      fail(PROPOSAL_GRAPH_ERROR_CODES.sourceInvalid, 'Proposal source must match the declared dependency.');
    }
  } else if (dependency !== null) {
    fail(PROPOSAL_GRAPH_ERROR_CODES.sourceInvalid, 'A dependency requires an explicit proposal source.');
  }
  if (dependency && dependency.proposalId === replacesProposalId) {
    fail(PROPOSAL_GRAPH_ERROR_CODES.sourceInvalid, 'A replacement must retain the original prerequisite, not depend on its replaced proposal.');
  }
  return value;
}

function assertUniqueIds(ids: readonly string[], message: string): void {
  if (new Set(ids).size !== ids.length) fail(PROPOSAL_GRAPH_ERROR_CODES.invalidRequest, message);
}

export function parseProposalActionFenceV1(value: unknown): ProposalActionFenceV1 {
  assertProposalGraphContractV1(ProposalActionFenceSchemaV1, value);
  if (value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > PROPOSAL_GRAPH_LIMITS.fenceLifetimeMs) {
    fail(PROPOSAL_GRAPH_ERROR_CODES.invalidRequest, 'Invalid approval lifetime.');
  }
  if (!['reject', 'branch_reject'].includes(value.actionType) && !value.current) {
    fail(PROPOSAL_GRAPH_ERROR_CODES.sourceInvalid, 'This action requires an authoritative current proof.');
  }
  if ((PROPOSAL_ACTION_RULES_V1[value.actionType].writesContent || value.actionType === 'complete_satisfied')
    && (!value.evaluationId || !value.effectiveCandidateHash)) {
    fail(PROPOSAL_GRAPH_ERROR_CODES.sourceInvalid, 'Content approval requires the displayed candidate evaluation.');
  }
  const closureIds = value.closure.map((member) => member.proposalId);
  assertUniqueIds(closureIds, 'Closure members must be unique.');
  assertUniqueIds(value.choiceResolutions.map((choice) => choice.groupId), 'Choice resolutions must be unique.');
  const closure = new Set(closureIds);
  if ([...value.selectedProposalIds, ...value.applyProposalIds].some((id) => !closure.has(id))) {
    fail(PROPOSAL_GRAPH_ERROR_CODES.invalidRequest, 'Selection and apply set must belong to the authorized closure.');
  }
  if (value.actionType !== 'batch_accept' && value.selectedProposalIds.length !== 1) {
    fail(PROPOSAL_GRAPH_ERROR_CODES.invalidRequest, 'Only batch accept permits multiple selected proposals.');
  }
  if (!PROPOSAL_ACTION_RULES_V1[value.actionType].writesContent && value.applyProposalIds.length > 0) {
    fail(PROPOSAL_GRAPH_ERROR_CODES.invalidRequest, 'Metadata actions cannot apply proposal content.');
  }
  if (PROPOSAL_ACTION_RULES_V1[value.actionType].writesContent && value.applyProposalIds.length === 0) {
    fail(PROPOSAL_GRAPH_ERROR_CODES.noEffect, 'Accept requires a nonempty application set.');
  }
  for (const choice of value.choiceResolutions) {
    if (!closure.has(choice.chosenProposalId) || choice.closingProposalIds.includes(choice.chosenProposalId)
      || choice.closingProposalIds.some((id) => !closure.has(id))) {
      fail(PROPOSAL_GRAPH_ERROR_CODES.choiceConflict, 'Choice resolution is outside the authorized closure.');
    }
  }
  if (!PROPOSAL_ACTION_RULES_V1[value.actionType].closesAlternatives && value.choiceResolutions.length) {
    fail(PROPOSAL_GRAPH_ERROR_CODES.choiceConflict, 'This action cannot choose an alternative.');
  }
  return value;
}

export function parseProposalEvaluationV1(value: unknown): ProposalEvaluationV1 {
  assertProposalGraphContractV1(ProposalEvaluationSchemaV1, value);
  if (value.expiresAt <= value.evaluatedAt) fail(PROPOSAL_GRAPH_ERROR_CODES.invalidRequest, 'Invalid evaluation lifetime.');
  if (['clean', 'clean_rebased', 'satisfied_elsewhere'].includes(value.status)
    && (!value.effectiveCandidate || !value.anchorMap || !value.effectPreconditions)) {
    fail(PROPOSAL_GRAPH_ERROR_CODES.sourceInvalid, 'Applicable evaluations require candidate and identity proofs.');
  }
  return value;
}

export function parseProposalActionRequestV1(value: unknown): ProposalActionRequestV1 {
  assertProposalGraphContractV1(ProposalActionRequestSchemaV1, value);
  parseProposalPreparedActionV1({ fence: value.fence, creation: value.creation });
  return value;
}

/** Shared persistence boundary without transport secrets or a fabricated token. */
export function parseProposalPreparedActionV1(value: unknown): Pick<ProposalActionRequestV1, 'fence' | 'creation'> {
  assertProposalGraphContractV1(Type.Object({
    fence: ProposalActionFenceSchemaV1,
    creation: Type.Union([ProposalCreateRequestSchemaV1, Type.Null()]),
  }, closed), value);
  parseProposalActionFenceV1(value.fence);
  const creates = PROPOSAL_ACTION_RULES_V1[value.fence.actionType].createsProposal;
  if (creates !== (value.creation !== null)) fail(PROPOSAL_GRAPH_ERROR_CODES.invalidRequest, 'This action requires exactly its own prepared creation.');
  if (value.creation) {
    parseProposalCreateRequestV1(value.creation);
    if (!sameScope(value.creation.scope, value.fence.scope)
      || value.fence.closure.some((member) => member.proposalId === value.creation!.proposalId)) {
      fail(PROPOSAL_GRAPH_ERROR_CODES.scopeMismatch, 'Prepared proposal must be new and in the action scope.');
    }
    const target = value.fence.selectedProposalIds[0];
    if ((value.fence.actionType === 'replace' && (value.creation.creationKind !== 'replacement' || value.creation.relationships.replacesProposalId !== target))
      || (value.fence.actionType === 'detach' && (value.creation.creationKind !== 'detached' || value.creation.detachedFromProposalId !== target))) {
      fail(PROPOSAL_GRAPH_ERROR_CODES.sourceInvalid, 'Prepared creation does not match the selected action.');
    }
  }
  return value;
}

export function parseProposalCreateRequestV1(value: unknown): ProposalCreateRequestV1 {
  assertProposalGraphContractV1(ProposalCreateRequestSchemaV1, value);
  parseProposalNodeV1({
    contractVersion: value.contractVersion, proposalId: value.proposalId, operationId: value.operationId,
    scope: value.scope, source: value.source, relationships: value.relationships,
    authoredCandidate: value.authoredCandidate, casVersion: 1, lifecycle: 'open', createdAt: 0, createdByActorId: 'contract-validation',
  });
  const { creationKind, relationships, detachedFromProposalId } = value;
  if ((creationKind === 'replacement') !== (relationships.replacesProposalId !== null)
    || (creationKind === 'detached') !== (detachedFromProposalId !== null)
    || (['independent', 'detached'].includes(creationKind) && relationships.dependency !== null)
    || (creationKind === 'extends' && relationships.dependency === null)
    || (creationKind === 'detached' && relationships.choiceGroupId !== null)
    || detachedFromProposalId === value.proposalId) {
    fail(PROPOSAL_GRAPH_ERROR_CODES.sourceInvalid, 'Creation kind does not match its provenance and relationships.');
  }
  return value;
}

export function parseProposalActionReceiptV1(value: unknown): ProposalActionReceiptV1 {
  assertProposalGraphContractV1(ProposalActionReceiptSchemaV1, value);
  if (value.updatedAt < value.createdAt) fail(PROPOSAL_GRAPH_ERROR_CODES.invalidRequest, 'Receipt update predates creation.');
  if (['applying', 'awaiting_durability'].includes(value.phase)
    && (!value.operationId || !PROPOSAL_ACTION_RULES_V1[value.actionType].writesContent)) {
    fail(PROPOSAL_GRAPH_ERROR_CODES.invalidRequest, 'Live apply phases require a linked content operation.');
  }
  if (value.phase !== 'succeeded') return value;
  const { result } = value;
  assertUniqueIds(result.resolutions.map((resolution) => resolution.proposalId), 'Receipt resolutions must be unique.');
  if (result.resolutions.some((resolution) => !value.affectedProposalIds.includes(resolution.proposalId))) {
    fail(PROPOSAL_GRAPH_ERROR_CODES.invalidRequest, 'Receipt resolution is outside its affected proposals.');
  }
  if (result.kind === 'content_changed') {
    if (!PROPOSAL_ACTION_RULES_V1[value.actionType].writesContent || !value.operationId
      || result.current.revisionId !== result.revisionId
      || !result.resolutions.some((resolution) => resolution.lifecycle === 'applied')
      || result.resolutions.some((resolution) => !['applied', 'included', 'alternative_not_selected'].includes(resolution.lifecycle))
      || (value.actionType === 'accept' && result.resolutions.filter((resolution) => resolution.lifecycle === 'applied').length !== 1)) {
      fail(PROPOSAL_GRAPH_ERROR_CODES.invalidRequest, 'Content success requires an accepted operation and its durable revision.');
    }
  } else if (PROPOSAL_ACTION_RULES_V1[value.actionType].writesContent
    || result.resolutions.some((resolution) => ['applied', 'included', 'alternative_not_selected'].includes(resolution.lifecycle))) {
    fail(PROPOSAL_GRAPH_ERROR_CODES.noEffect, 'A metadata result cannot claim content application or choose alternatives.');
  } else {
    if (result.createdProposalIds.length !== (PROPOSAL_ACTION_RULES_V1[value.actionType].createsProposal ? 1 : 0)
      || result.createdProposalIds.some((id) => value.affectedProposalIds.includes(id))) {
      fail(PROPOSAL_GRAPH_ERROR_CODES.invalidRequest, 'Creation result must identify one newly created proposal.');
    }
    const resolution = PROPOSAL_ACTION_RULES_V1[value.actionType].resolution;
    if (result.resolutions.some((entry) => entry.lifecycle !== resolution)
      || (resolution !== null && result.resolutions.length === 0)
      || (['replace', 'complete_satisfied', 'reject'].includes(value.actionType) && result.resolutions.length !== 1)) {
      fail(PROPOSAL_GRAPH_ERROR_CODES.invalidTransition, 'Receipt resolutions do not match the action.');
    }
  }
  return value;
}

/** Bounded structural checks only; no authorization, semantic independence or merge claim. */
export function parseProposalGraphSnapshotV1(value: unknown): ProposalGraphSnapshotV1 {
  assertProposalGraphContractV1(ProposalGraphSnapshotSchemaV1, value);
  assertUniqueIds(value.nodes.map((node) => node.proposalId), 'Proposal IDs must be unique.');
  assertUniqueIds(value.choiceGroups.map((group) => group.groupId), 'Choice group IDs must be unique.');
  const nodes = new Map(value.nodes.map((node) => [node.proposalId, node]));
  const archivedReplacements = new Set(value.archivedReplacementProposalIds ?? []);
  if ([...archivedReplacements].some((id) => nodes.has(id))) fail(PROPOSAL_GRAPH_ERROR_CODES.invalidRequest, 'Archived replacements cannot duplicate projected nodes.');
  const groups = new Map(value.choiceGroups.map((group) => [group.groupId, group]));
  const rootCounts = new Map<string, number>();
  for (const node of value.nodes) {
    parseProposalNodeV1(node);
    if (!sameScope(value.scope, node.scope)) fail(PROPOSAL_GRAPH_ERROR_CODES.scopeMismatch, 'Graph crosses a document scope.');
    const dependency = node.relationships.dependency;
    if (dependency && nodes.get(dependency.proposalId)?.authoredCandidate.cumulativeCandidate.sha256 !== dependency.candidateHash) {
      fail(PROPOSAL_GRAPH_ERROR_CODES.parentChanged, 'Dependency candidate is absent or changed.');
    }
    const replaced = node.relationships.replacesProposalId ? nodes.get(node.relationships.replacesProposalId) : null;
    if (node.relationships.replacesProposalId && !replaced
      && (node.lifecycle === 'open' || !archivedReplacements.has(node.relationships.replacesProposalId))) {
      fail(PROPOSAL_GRAPH_ERROR_CODES.sourceInvalid, 'Replacement target is missing.');
    }
    if (replaced && (replaced.relationships.dependency?.proposalId !== dependency?.proposalId
      || replaced.relationships.choiceGroupId !== node.relationships.choiceGroupId)) {
      fail(PROPOSAL_GRAPH_ERROR_CODES.sourceInvalid, 'Replacement must retain dependency and choice group.');
    }
    for (const edge of ['dependency', 'replacement'] as const) {
      const seen = new Set<string>([node.proposalId]);
      let cursor = node;
      let depth = 0;
      for (;;) {
        const nextId = edge === 'dependency' ? cursor.relationships.dependency?.proposalId : cursor.relationships.replacesProposalId;
        if (!nextId) break;
        if (seen.has(nextId)) fail(PROPOSAL_GRAPH_ERROR_CODES.cycle, 'Proposal relationship cycle.');
        seen.add(nextId);
        const next = nodes.get(nextId);
        if (!next) {
          if (edge === 'replacement' && cursor.lifecycle !== 'open' && archivedReplacements.has(nextId)) break;
          fail(PROPOSAL_GRAPH_ERROR_CODES.sourceInvalid, 'Relationship target is missing.');
        }
        cursor = next;
        depth++;
        if (depth > PROPOSAL_GRAPH_LIMITS.dependencyDepth) fail(PROPOSAL_GRAPH_ERROR_CODES.limitExceeded, 'Proposal relationship depth exceeded.');
      }
      if (edge === 'dependency') rootCounts.set(cursor.proposalId, (rootCounts.get(cursor.proposalId) ?? 0) + 1);
    }
    const groupId = node.relationships.choiceGroupId;
    if (groupId && !groups.get(groupId)?.memberProposalIds.includes(node.proposalId)) {
      fail(PROPOSAL_GRAPH_ERROR_CODES.choiceConflict, 'Proposal choice membership is missing.');
    }
  }
  if ([...rootCounts.values()].some((count) => count > PROPOSAL_GRAPH_LIMITS.nodesPerRoot)
    || value.nodes.filter((node) => !node.relationships.dependency && node.lifecycle === 'open').length > PROPOSAL_GRAPH_LIMITS.openRootsPerDocument) {
    fail(PROPOSAL_GRAPH_ERROR_CODES.limitExceeded, 'Proposal root limit exceeded.');
  }
  for (const group of value.choiceGroups) {
    if (group.memberProposalIds.length + (group.archivedMemberCount ?? 0) < 2) {
      fail(PROPOSAL_GRAPH_ERROR_CODES.choiceConflict, 'A choice group requires at least two historical members.');
    }
    for (const id of group.memberProposalIds) {
      const node = nodes.get(id);
      if (!node || node.relationships.choiceGroupId !== group.groupId
        || (node.relationships.dependency?.proposalId ?? null) !== group.dependencyProposalId) {
        fail(PROPOSAL_GRAPH_ERROR_CODES.choiceConflict, 'Alternatives must share a prerequisite and group.');
      }
    }
    if (group.chosenProposalId !== null && !group.memberProposalIds.includes(group.chosenProposalId)) {
      fail(PROPOSAL_GRAPH_ERROR_CODES.choiceConflict, 'Chosen proposal is not a group member.');
    }
  }
  return value;
}

/** No origin is guessed from text overlap. Partial legacy payloads need a new reviewed candidate. */
export function projectLegacyProposalV1(value: unknown): ProposalLegacyProjectionV1 {
  assertProposalGraphContractV1(ProposalLegacyEvidenceSchemaV1, value);
  if (value.source && !sameScope(value.scope, value.source.scope)) fail(PROPOSAL_GRAPH_ERROR_CODES.scopeMismatch, 'Legacy source belongs to another document.');
  const originalTargets = new Set(value.targetScope.originalTargetIds);
  const appliedTargets = new Set(value.targetScope.appliedTargetIds);
  if ([...value.targetScope.appliedTargetIds, ...value.targetScope.pendingTargetIds].some((id) => !originalTargets.has(id))
    || value.targetScope.pendingTargetIds.some((id) => appliedTargets.has(id))) {
    fail(PROPOSAL_GRAPH_ERROR_CODES.sourceInvalid, 'Legacy applied and remaining targets must be disjoint original targets.');
  }
  let reason: ProposalLegacyProjectionV1['reason'] = null;
  if (value.recoveryStatus === 'uncertain' || ['applying', 'applied_to_ydoc'].includes(value.operationStatus)) reason = 'recovery_uncertain';
  else if (value.appliedScope === 'partial' || value.operationStatus === 'partially_applied') reason = 'partial_operation';
  else if (value.appliedScope === 'all') reason = 'already_resolved';
  else if (!['ready', 'needs_review'].includes(value.operationStatus)) reason = 'already_resolved';
  else if (value.relationshipKnowledge === 'graph_bound' || value.provenance === 'proposal_based') reason = 'graph_bound';
  else if (value.provenance !== 'verified_authoritative' || value.relationshipKnowledge !== 'independent' || value.appliedScope !== 'none') reason = 'unknown_origin';
  else if (!value.source || value.source.kind !== 'authoritative' || !value.remainingPayload || value.appliedPayloadHash !== null
    || value.remainingPayload.sha256 !== value.originalPayloadHash || value.targetScope.proof !== 'verified'
    || originalTargets.size === 0 || appliedTargets.size !== 0
    || value.targetScope.pendingTargetIds.length !== originalTargets.size) reason = 'missing_evidence';
  return { contractVersion: 1, status: reason ? 'blocked' : 'safe_independent', reason, reviewRequired: true, evidence: value };
}

export function parseProposalLegacyProjectionV1(value: unknown): ProposalLegacyProjectionV1 {
  assertProposalGraphContractV1(ProposalLegacyProjectionSchemaV1, value);
  const expected = projectLegacyProposalV1(value.evidence);
  if (value.status !== expected.status || value.reason !== expected.reason) fail(PROPOSAL_GRAPH_ERROR_CODES.legacyBlocked, 'Legacy projection does not match its evidence.');
  return value;
}
