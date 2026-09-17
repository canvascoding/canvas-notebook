/**
 * Wire fixtures for FVRC-1000. No production builders are used here: changing
 * a contract cannot silently change both the input and its expected result.
 * Hashes identify fixed test artifacts; these tests do not compose Yjs edits.
 */
export const proposalScopeFixture = {
  workspaceId: 'workspace-shipping',
  lineageId: 'lineage-shipping',
  documentId: 'document-shipping',
  lifecycleGeneration: 1,
  schemaVersion: 1,
};

export const currentProofFixture = {
  revisionId: 'revision-v0',
  contentHash: '0'.repeat(64),
  structureHash: '1'.repeat(64),
  stateVectorHash: '2'.repeat(64),
  deleteSetHash: '3'.repeat(64),
  fullStateHash: '4'.repeat(64),
};

const artifactFixture = (ref: string, hash: string) => ({
  ref,
  sha256: hash.repeat(64),
  sizeBytes: 128,
});

const snapshotFixture = (ref: string, hash: string) => ({
  ...artifactFixture(ref, hash),
  encoding: 'yjs_full_update_v1',
});

export const rootProposalFixture = {
  contractVersion: 1,
  proposalId: 'p1',
  operationId: 'operation-p1',
  scope: proposalScopeFixture,
  casVersion: 1,
  source: {
    kind: 'authoritative',
    scope: proposalScopeFixture,
    current: currentProofFixture,
    snapshot: snapshotFixture('snapshot-v0', '5'),
    anchorMap: artifactFixture('anchors-v0', '6'),
  },
  relationships: {
    dependency: null,
    replacesProposalId: null,
    choiceGroupId: null,
  },
  authoredCandidate: {
    incrementalPayload: artifactFixture('increment-p1', '7'),
    cumulativeCandidate: snapshotFixture('candidate-p1', '8'),
    effectPreconditions: artifactFixture('preconditions-p1', '9'),
    sourceProofHash: 'a'.repeat(64),
  },
  lifecycle: 'open',
  createdAt: 1_789_646_400_000,
  createdByActorId: 'agent-shipping',
};

export const independentProposalFixture = {
  ...rootProposalFixture,
  proposalId: 'q',
  operationId: 'operation-q',
  authoredCandidate: {
    ...rootProposalFixture.authoredCandidate,
    incrementalPayload: artifactFixture('increment-q', 'b'),
    cumulativeCandidate: snapshotFixture('candidate-q', 'c'),
  },
};

export const childProposalFixture = {
  ...rootProposalFixture,
  proposalId: 'p2',
  operationId: 'operation-p2',
  source: {
    ...rootProposalFixture.source,
    kind: 'proposal',
    proposalId: 'p1',
    proposalCasVersion: 1,
    candidateHash: '8'.repeat(64),
    authoredCandidateHash: '8'.repeat(64),
    evaluationId: null,
    snapshot: snapshotFixture('snapshot-p1', '8'),
    anchorMap: artifactFixture('anchors-p1', 'e'),
  },
  relationships: {
    dependency: { proposalId: 'p1', candidateHash: '8'.repeat(64) },
    replacesProposalId: null,
    choiceGroupId: 'choice-insurance',
  },
  authoredCandidate: {
    ...rootProposalFixture.authoredCandidate,
    incrementalPayload: artifactFixture('increment-p2', 'b'),
    cumulativeCandidate: snapshotFixture('candidate-p2', 'c'),
  },
};

export const alternativeChildFixture = {
  ...childProposalFixture,
  proposalId: 'p3',
  operationId: 'operation-p3',
  authoredCandidate: {
    ...childProposalFixture.authoredCandidate,
    incrementalPayload: artifactFixture('increment-p3', 'd'),
    cumulativeCandidate: snapshotFixture('candidate-p3', 'e'),
  },
};

export const replacementChildFixture = {
  ...childProposalFixture,
  proposalId: 'r',
  operationId: 'operation-r',
  relationships: {
    dependency: { proposalId: 'p1', candidateHash: '8'.repeat(64) },
    replacesProposalId: 'p2',
    choiceGroupId: 'choice-insurance',
  },
  authoredCandidate: {
    ...childProposalFixture.authoredCandidate,
    incrementalPayload: artifactFixture('increment-r', 'f'),
    cumulativeCandidate: snapshotFixture('candidate-r', '0'),
  },
};

/** PG-S08: a replacement is still dependent on P1 and an alternative to P3. */
export const dependentAlternativeGraphFixture = {
  contractVersion: 1,
  scope: proposalScopeFixture,
  graphRevision: 4,
  nodes: [
    rootProposalFixture,
    independentProposalFixture,
    { ...childProposalFixture, lifecycle: 'superseded' },
    alternativeChildFixture,
    replacementChildFixture,
  ],
  choiceGroups: [{
    groupId: 'choice-insurance',
    groupRevision: 2,
    dependencyProposalId: 'p1',
    memberProposalIds: ['p2', 'p3', 'r'],
    chosenProposalId: null,
  }],
};

export const cleanEvaluationFixture = {
  contractVersion: 1,
  evaluationId: 'evaluation-p2-v0',
  proposalId: 'p2',
  scope: proposalScopeFixture,
  current: currentProofFixture,
  graphRevision: 3,
  status: 'clean',
  reasonCode: null,
  effectiveCandidate: snapshotFixture('effective-p2-v0', 'c'),
  anchorMap: artifactFixture('effective-anchors-p2-v0', 'd'),
  effectPreconditions: artifactFixture('effective-preconditions-p2-v0', 'e'),
  evaluatedAt: 1_789_646_400_000,
  expiresAt: 1_789_646_460_000,
};

/** PG-S03/S10: approving P2 visibly includes P1 and closes P3. */
export const acceptFenceFixture = {
  contractVersion: 1,
  fenceId: 'fence-p2-v0',
  scope: proposalScopeFixture,
  actor: { userId: 'reviewer', actorId: 'reviewer', authorizationRevision: 'access-7' },
  actionType: 'accept',
  current: currentProofFixture,
  graphRevision: 3,
  evaluationId: 'evaluation-p2-v0',
  effectiveCandidateHash: 'c'.repeat(64),
  closure: [
    { proposalId: 'p1', casVersion: 1, candidateHash: '8'.repeat(64) },
    { proposalId: 'p2', casVersion: 1, candidateHash: 'c'.repeat(64) },
    { proposalId: 'p3', casVersion: 1, candidateHash: 'e'.repeat(64) },
  ],
  closureHash: 'b'.repeat(64),
  selectedProposalIds: ['p2'],
  applyProposalIds: ['p1', 'p2'],
  batchHash: 'd'.repeat(64),
  choiceResolutions: [{
    groupId: 'choice-insurance',
    groupRevision: 1,
    chosenProposalId: 'p2',
    closingProposalIds: ['p3'],
  }],
  requestDigest: 'e'.repeat(64),
  issuedAt: 1_789_646_400_000,
  expiresAt: 1_789_646_460_000,
};

export const pendingReceiptFixture = {
  contractVersion: 1,
  actionId: 'action-accept-p2',
  scope: proposalScopeFixture,
  actorId: 'reviewer',
  actionType: 'accept',
  requestDigest: 'e'.repeat(64),
  idempotencyKeyHash: 'f'.repeat(64),
  affectedProposalIds: ['p1', 'p2', 'p3'],
  operationId: 'operation-chain-p1-p2',
  createdAt: 1_789_646_400_000,
  updatedAt: 1_789_646_410_000,
  phase: 'awaiting_durability',
  result: null,
  errorCode: null,
};

export const durableReceiptFixture = {
  ...pendingReceiptFixture,
  phase: 'succeeded',
  result: {
    kind: 'content_changed',
    revisionId: 'revision-v1',
    current: {
      revisionId: 'revision-v1',
      contentHash: 'a'.repeat(64),
      structureHash: 'b'.repeat(64),
      stateVectorHash: 'c'.repeat(64),
      deleteSetHash: 'd'.repeat(64),
      fullStateHash: 'e'.repeat(64),
    },
    resolutions: [
      { proposalId: 'p1', lifecycle: 'included' },
      { proposalId: 'p2', lifecycle: 'applied' },
      { proposalId: 'p3', lifecycle: 'alternative_not_selected' },
    ],
    createdProposalIds: [],
  },
};

export const legacyEvidenceFixture = {
  contractVersion: 1,
  operationId: 'legacy-operation-1',
  operationStatus: 'ready',
  recoveryStatus: 'settled',
  scope: proposalScopeFixture,
  provenance: 'verified_authoritative',
  appliedScope: 'none',
  relationshipKnowledge: 'independent',
  source: rootProposalFixture.source,
  originalPayloadHash: '7'.repeat(64),
  appliedPayloadHash: null,
  remainingPayload: artifactFixture('legacy-payload', '7'),
  targetScope: {
    proof: 'verified',
    originalTargetIds: ['target-shipping-price', 'target-shipping-insurance'],
    appliedTargetIds: [],
    pendingTargetIds: ['target-shipping-price', 'target-shipping-insurance'],
  },
};
