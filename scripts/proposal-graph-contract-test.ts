import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PROPOSAL_ACTION_RULES_V1,
  PROPOSAL_GRAPH_LIMITS,
  ProposalGraphContractError,
  canTransitionProposalLifecycleV1,
  canTransitionProposalReceiptV1,
  parseProposalActionFenceV1,
  parseProposalActionReceiptV1,
  parseProposalActionRequestV1,
  parseProposalCreateRequestV1,
  parseProposalEvaluationV1,
  parseProposalGraphSnapshotV1,
  parseProposalLegacyProjectionV1,
  parseProposalNodeV1,
  projectLegacyProposalV1,
  type ProposalGraphErrorCode,
} from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import {
  acceptFenceFixture,
  childProposalFixture,
  cleanEvaluationFixture,
  currentProofFixture,
  dependentAlternativeGraphFixture,
  durableReceiptFixture,
  legacyEvidenceFixture,
  pendingReceiptFixture,
  replacementChildFixture,
  rootProposalFixture,
} from './fixtures/proposal-graph-contract-v1';

const absent = Symbol('absent');

function changed(input: unknown, path: readonly (string | number)[], value: unknown): unknown {
  // Wire payloads have no shared object identity. Break fixture aliases so a
  // mutation of source.scope cannot accidentally mutate node.scope as well.
  const result: unknown = JSON.parse(JSON.stringify(input));
  let cursor = result as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) {
    cursor = cursor[key] as Record<string | number, unknown>;
  }
  const last = path[path.length - 1];
  if (value === absent) delete cursor[last];
  else cursor[last] = value;
  return result;
}

function rejects(
  parse: (input: unknown) => unknown,
  input: unknown,
  reason: string,
  expectedCode: ProposalGraphErrorCode = 'PROPOSAL_INVALID_REQUEST',
): void {
  assert.throws(() => parse(input), (error: unknown) => {
    assert.ok(error instanceof ProposalGraphContractError, reason);
    assert.equal(error.code, expectedCode, reason);
    return true;
  }, reason);
}

test('PG-S08: dependency, replacement and choice are orthogonal wire properties', () => {
  const graph = parseProposalGraphSnapshotV1(dependentAlternativeGraphFixture);
  const replacement = graph.nodes.find((node) => node.proposalId === 'r');
  assert.ok(replacement);
  assert.deepEqual(replacement.relationships, {
    dependency: { proposalId: 'p1', candidateHash: '8'.repeat(64) },
    replacesProposalId: 'p2',
    choiceGroupId: 'choice-insurance',
  });
  assert.equal(graph.nodes.find((node) => node.proposalId === 'p2')?.lifecycle, 'superseded');
  assert.equal(graph.nodes.find((node) => node.proposalId === 'p3')?.lifecycle, 'open');
  assert.equal(graph.choiceGroups[0]?.dependencyProposalId, 'p1');
  assert.deepEqual(graph.choiceGroups[0]?.memberProposalIds, ['p2', 'p3', 'r']);
  assert.deepEqual(parseProposalNodeV1(replacementChildFixture), replacementChildFixture);
});

test('PG-S03/S05/S09: terminal lifecycle observations are idempotent and never reopen', () => {
  const terminal = [
    'applied', 'included', 'rejected', 'superseded',
    'alternative_not_selected', 'satisfied_elsewhere', 'expired',
  ] as const;
  assert.equal(canTransitionProposalLifecycleV1('open', 'open'), true);
  for (const lifecycle of terminal) {
    assert.equal(canTransitionProposalLifecycleV1('open', lifecycle), true);
    assert.equal(canTransitionProposalLifecycleV1(lifecycle, lifecycle), true);
    assert.equal(canTransitionProposalLifecycleV1(lifecycle, 'open'), false);
    for (const other of terminal) {
      if (lifecycle !== other) {
        assert.equal(canTransitionProposalLifecycleV1(lifecycle, other), false,
          `${lifecycle} cannot become ${other}`);
      }
    }
    assert.equal(parseProposalNodeV1({ ...rootProposalFixture, lifecycle }).lifecycle, lifecycle);
  }
});

test('PG-S11: transient applicability and durability must not masquerade as lifecycle', () => {
  for (const lifecycle of [
    'clean', 'rebase_pending', 'blocked_by_parent', 'prerequisite_lost',
    'conflicted', 'applying', 'awaiting_durability', 'recovery_required',
  ]) {
    rejects(parseProposalNodeV1, { ...rootProposalFixture, lifecycle }, lifecycle);
  }
});

test('proposal inputs reject unknown fields instead of discarding authority-bearing data', () => {
  for (const path of [
    ['admin'], ['scope', 'tenantOverride'], ['source', 'grantId'],
    ['relationships', 'independent'], ['authoredCandidate', 'markdown'],
    ['authoredCandidate', 'incrementalPayload', 'inlineContent'],
  ]) {
    rejects(parseProposalNodeV1, changed(rootProposalFixture, path, true), path.join('.'));
  }
  rejects(parseProposalNodeV1, { ...rootProposalFixture, contractVersion: 2 }, 'unknown version',
    'PROPOSAL_UNSUPPORTED_VERSION');
  rejects(parseProposalNodeV1, { ...rootProposalFixture, versionNumber: 27.1 },
    'pending proposals cannot claim authoritative version numbers');
});

test('PG-S20/S31: basis proof includes deletion-aware identity and immutable ancestry', () => {
  for (const field of ['revisionId', 'contentHash', 'structureHash', 'stateVectorHash', 'deleteSetHash', 'fullStateHash']) {
    rejects(parseProposalNodeV1, changed(rootProposalFixture, ['source', 'current', field], absent),
      `missing ${field}`);
  }
  for (const path of [
    ['source', 'snapshot'], ['source', 'anchorMap'], ['authoredCandidate', 'sourceProofHash'],
    ['authoredCandidate', 'effectPreconditions'], ['source', 'scope'],
  ]) {
    rejects(parseProposalNodeV1, changed(rootProposalFixture, path, absent), path.join('.'));
  }
  for (const path of [
    ['source', 'candidateHash'], ['source', 'authoredCandidateHash'],
    ['source', 'proposalCasVersion'], ['source', 'evaluationId'],
    ['source', 'snapshot', 'encoding'], ['authoredCandidate', 'cumulativeCandidate', 'encoding'],
  ]) {
    rejects(parseProposalNodeV1, changed(childProposalFixture, path, absent), path.join('.'));
  }
  rejects(parseProposalNodeV1,
    changed(childProposalFixture, ['relationships', 'dependency'], null),
    'a proposal source cannot silently become independent', 'PROPOSAL_SOURCE_INVALID');
  rejects(parseProposalNodeV1,
    changed(childProposalFixture, ['source', 'proposalId'], 'other-parent'),
    'source and dependency must refer to the same proposal', 'PROPOSAL_SOURCE_INVALID');
  rejects(parseProposalNodeV1,
    changed(childProposalFixture, ['source', 'candidateHash'], 'f'.repeat(64)),
    'source and dependency must agree on candidate identity', 'PROPOSAL_SOURCE_INVALID');
});

test('PG-S23/S28/S30: scope, lifecycle generation, schema and identity are explicit', () => {
  for (const [field, value] of [
    ['workspaceId', 'workspace-other'], ['lineageId', 'lineage-other'],
    ['documentId', 'document-other'], ['lifecycleGeneration', 2], ['schemaVersion', 2],
  ] as const) {
    rejects(parseProposalNodeV1,
      changed(rootProposalFixture, ['source', 'scope', field], value), `source ${field}`,
      'PROPOSAL_SCOPE_MISMATCH');
    const foreignGraph = changed(dependentAlternativeGraphFixture, ['nodes', 1, 'scope', field], value);
    const foreignGraphAndSource = changed(foreignGraph, ['nodes', 1, 'source', 'scope', field], value);
    rejects(parseProposalGraphSnapshotV1, foreignGraphAndSource, `graph ${field}`, 'PROPOSAL_SCOPE_MISMATCH');
  }
  for (const invalidGeneration of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const invalidScope = changed(rootProposalFixture, ['scope', 'lifecycleGeneration'], invalidGeneration);
    rejects(parseProposalNodeV1,
      changed(invalidScope, ['source', 'scope', 'lifecycleGeneration'], invalidGeneration),
      `invalid generation ${invalidGeneration}`);
  }
  for (const invalidHash of ['', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) {
    rejects(parseProposalNodeV1,
      changed(rootProposalFixture, ['authoredCandidate', 'cumulativeCandidate', 'sha256'], invalidHash),
      `invalid candidate hash ${invalidHash}`);
  }
});

test('PG-S30: structural graph guards reject missing, duplicate and self references', () => {
  rejects(parseProposalNodeV1, {
    ...childProposalFixture,
    proposalId: 'p1',
  }, 'self dependency', 'PROPOSAL_CYCLE');
  rejects(parseProposalNodeV1, {
    ...replacementChildFixture,
    relationships: { ...replacementChildFixture.relationships, replacesProposalId: 'r' },
  }, 'self replacement', 'PROPOSAL_CYCLE');
  rejects(parseProposalGraphSnapshotV1, {
    ...dependentAlternativeGraphFixture,
    nodes: dependentAlternativeGraphFixture.nodes.slice(1),
  }, 'missing dependency target', 'PROPOSAL_PARENT_CHANGED');
  rejects(parseProposalGraphSnapshotV1, {
    ...dependentAlternativeGraphFixture,
    nodes: [...dependentAlternativeGraphFixture.nodes, rootProposalFixture],
  }, 'duplicate proposal ID');
  rejects(parseProposalGraphSnapshotV1,
    changed(dependentAlternativeGraphFixture, ['nodes', 4, 'relationships', 'replacesProposalId'], 'missing'),
    'missing replacement target', 'PROPOSAL_SOURCE_INVALID');
  rejects(parseProposalGraphSnapshotV1,
    changed(dependentAlternativeGraphFixture, ['choiceGroups', 0, 'memberProposalIds'], ['p2', 'p2', 'r']),
    'duplicate group member');
  rejects(parseProposalGraphSnapshotV1,
    changed(dependentAlternativeGraphFixture, ['choiceGroups', 0, 'chosenProposalId'], 'q'),
    'chosen option must belong to the group', 'PROPOSAL_CHOICE_CONFLICT');
});

test('PG-S08/S10: alternative prerequisites and memberships cannot contradict one another', () => {
  rejects(parseProposalGraphSnapshotV1,
    changed(dependentAlternativeGraphFixture, ['choiceGroups', 0, 'dependencyProposalId'], null),
    'dependent siblings cannot be advertised as independent options', 'PROPOSAL_CHOICE_CONFLICT');
  rejects(parseProposalGraphSnapshotV1,
    changed(dependentAlternativeGraphFixture, ['nodes', 3, 'relationships', 'choiceGroupId'], 'missing'),
    'node membership must resolve to an existing group', 'PROPOSAL_CHOICE_CONFLICT');
  rejects(parseProposalGraphSnapshotV1,
    changed(dependentAlternativeGraphFixture, ['choiceGroups', 0, 'memberProposalIds'], ['p1', 'p2', 'p3', 'r']),
    'ancestor and descendant cannot be alternatives', 'PROPOSAL_CHOICE_CONFLICT');
  rejects(parseProposalGraphSnapshotV1,
    changed(dependentAlternativeGraphFixture, ['nodes', 4, 'relationships', 'dependency', 'proposalId'], 'p2'),
    'replacement must not accidentally use its replaced proposal as source', 'PROPOSAL_SOURCE_INVALID');
});

test('PG-S30: dependency and replacement cycles are rejected independently', () => {
  const cyclicParent = {
    ...rootProposalFixture,
    source: {
      ...childProposalFixture.source,
      proposalId: 'p2',
      candidateHash: 'c'.repeat(64),
      authoredCandidateHash: 'c'.repeat(64),
      snapshot: { ...childProposalFixture.source.snapshot, sha256: 'c'.repeat(64) },
    },
    relationships: {
      dependency: { proposalId: 'p2', candidateHash: 'c'.repeat(64) },
      replacesProposalId: null,
      choiceGroupId: null,
    },
  };
  const childWithoutChoice = {
    ...childProposalFixture,
    relationships: { ...childProposalFixture.relationships, choiceGroupId: null },
  };
  rejects(parseProposalGraphSnapshotV1, {
    contractVersion: 1,
    scope: rootProposalFixture.scope,
    graphRevision: 1,
    nodes: [cyclicParent, childWithoutChoice],
    choiceGroups: [],
  }, 'two-node dependency cycle with otherwise consistent sources', 'PROPOSAL_CYCLE');

  rejects(parseProposalGraphSnapshotV1, {
    contractVersion: 1,
    scope: rootProposalFixture.scope,
    graphRevision: 1,
    nodes: [
      {
        ...rootProposalFixture,
        lifecycle: 'superseded',
        relationships: { ...rootProposalFixture.relationships, replacesProposalId: 'q' },
      },
      {
        ...rootProposalFixture,
        proposalId: 'q',
        operationId: 'operation-q',
        lifecycle: 'superseded',
        relationships: { ...rootProposalFixture.relationships, replacesProposalId: 'p1' },
      },
    ],
    choiceGroups: [],
  }, 'two-node replacement cycle does not need a dependency cycle', 'PROPOSAL_CYCLE');
});

test('an empty graph is a valid review list without inventing a proposal', () => {
  const graph = parseProposalGraphSnapshotV1({
    contractVersion: 1,
    scope: rootProposalFixture.scope,
    graphRevision: 1,
    nodes: [],
    choiceGroups: [],
  });
  assert.deepEqual(graph.nodes, []);
  assert.deepEqual(graph.choiceGroups, []);
});

test('PG-S04/S11: authored provenance and a later evaluated source can coexist', () => {
  const childOfRebasedParent = {
    ...childProposalFixture,
    source: {
      ...childProposalFixture.source,
      evaluationId: 'evaluation-p1-after-q',
      candidateHash: 'f'.repeat(64),
      snapshot: { ...childProposalFixture.source.snapshot, sha256: 'f'.repeat(64) },
    },
  };
  const parsed = parseProposalNodeV1(childOfRebasedParent);
  assert.equal(parsed.source.kind, 'proposal');
  if (parsed.source.kind !== 'proposal') assert.fail('Expected explicit parent provenance');
  assert.equal(parsed.source.authoredCandidateHash, '8'.repeat(64));
  assert.equal(parsed.source.candidateHash, 'f'.repeat(64));
  assert.equal(parsed.source.evaluationId, 'evaluation-p1-after-q');
  assert.equal(parsed.relationships.dependency?.candidateHash, '8'.repeat(64));
  rejects(parseProposalNodeV1,
    changed(childOfRebasedParent, ['source', 'evaluationId'], null),
    'changed parent candidate requires a pinned evaluation', 'PROPOSAL_SOURCE_INVALID');
});

test('PG-S11/S12: historical resolution and currently verified prerequisites remain distinct', () => {
  for (const lifecycle of ['applied', 'included', 'satisfied_elsewhere']) {
    const graph = parseProposalGraphSnapshotV1(
      changed(dependentAlternativeGraphFixture, ['nodes', 0, 'lifecycle'], lifecycle),
    );
    assert.equal(graph.nodes[0]?.lifecycle, lifecycle);
    const evaluation = parseProposalEvaluationV1({
      ...cleanEvaluationFixture,
      status: 'prerequisite_lost',
      reasonCode: 'PROPOSAL_PREREQUISITE_LOST',
      effectiveCandidate: null,
      anchorMap: null,
      effectPreconditions: null,
    });
    assert.equal(evaluation.status, 'prerequisite_lost');
    assert.equal(graph.nodes[0]?.lifecycle, lifecycle, 'evaluation cannot rewrite historical receipt');
  }
  for (const status of ['clean', 'clean_rebased', 'satisfied_elsewhere']) {
    assert.equal(parseProposalEvaluationV1({ ...cleanEvaluationFixture, status }).status, status);
    for (const field of ['effectiveCandidate', 'anchorMap', 'effectPreconditions']) {
      rejects(parseProposalEvaluationV1,
        changed({ ...cleanEvaluationFixture, status }, [field], null),
        `${status} needs ${field}`, 'PROPOSAL_SOURCE_INVALID');
    }
  }
  const empty = parseProposalEvaluationV1({
    ...cleanEvaluationFixture,
    status: 'empty_effect',
    reasonCode: 'PROPOSAL_NO_EFFECT',
    effectiveCandidate: null,
    anchorMap: null,
    effectPreconditions: null,
  });
  assert.equal(empty.status, 'empty_effect');
  assert.deepEqual(PROPOSAL_ACTION_RULES_V1.accept.evaluation, ['clean', 'clean_rebased']);
  assert.deepEqual(PROPOSAL_ACTION_RULES_V1.complete_satisfied, {
    from: ['open'], evaluation: ['satisfied_elsewhere'], resolution: 'satisfied_elsewhere',
    writesContent: false, createsProposal: false, includesDependencies: false, closesAlternatives: false,
  }, 'already-present effect does not implicitly approve alternatives or reapply its parent');
});

test('product action rules distinguish content, metadata and new reviewed proposals', () => {
  const expectations = {
    accept: [true, false, true, true, 'applied'],
    batch_accept: [true, false, true, true, 'applied'],
    reject: [false, false, false, false, 'rejected'],
    branch_reject: [false, false, false, false, 'rejected'],
    replace: [false, true, false, false, 'superseded'],
    detach: [false, true, false, false, null],
    rebase: [false, false, false, false, null],
    complete_satisfied: [false, false, false, false, 'satisfied_elsewhere'],
  } as const;
  assert.deepEqual(Object.keys(PROPOSAL_ACTION_RULES_V1).sort(), Object.keys(expectations).sort());
  for (const [name, expected] of Object.entries(expectations)) {
    const rule = PROPOSAL_ACTION_RULES_V1[name as keyof typeof expectations];
    assert.deepEqual([
      rule.writesContent, rule.createsProposal, rule.includesDependencies,
      rule.closesAlternatives, rule.resolution,
    ], expected, name);
    assert.deepEqual(rule.from, ['open'], `${name} cannot reopen a terminal proposal`);
  }
});

test('PG-S15/S18/S20: an acceptance fence binds current, graph, actor, selection and result', () => {
  const fence = parseProposalActionFenceV1(acceptFenceFixture);
  assert.deepEqual(fence.current, currentProofFixture);
  assert.equal(fence.graphRevision, 3);
  assert.equal(fence.evaluationId, 'evaluation-p2-v0');
  assert.equal(fence.effectiveCandidateHash, 'c'.repeat(64));
  assert.deepEqual(fence.selectedProposalIds, ['p2']);
  assert.deepEqual(fence.applyProposalIds, ['p1', 'p2']);
  assert.deepEqual(fence.choiceResolutions[0]?.closingProposalIds, ['p3']);
  for (const path of [
    ['current'], ['graphRevision'], ['closureHash'], ['batchHash'], ['requestDigest'],
    ['evaluationId'], ['effectiveCandidateHash'], ['actor', 'authorizationRevision'],
    ['scope', 'lineageId'], ['current', 'deleteSetHash'], ['current', 'fullStateHash'],
    ['closure', 0, 'casVersion'], ['closure', 0, 'candidateHash'],
  ]) {
    rejects(parseProposalActionFenceV1, changed(acceptFenceFixture, path, absent), path.join('.'));
  }
  rejects(parseProposalActionFenceV1,
    changed(acceptFenceFixture, ['closure'], [...acceptFenceFixture.closure, acceptFenceFixture.closure[0]]),
    'repeated closure member');
  rejects(parseProposalActionFenceV1,
    changed(acceptFenceFixture, ['selectedProposalIds'], ['unseen']), 'unseen selected proposal');
  rejects(parseProposalActionFenceV1,
    changed(acceptFenceFixture, ['applyProposalIds'], ['p1', 'unseen']), 'unseen applied proposal');
  rejects(parseProposalActionFenceV1,
    changed(acceptFenceFixture, ['choiceResolutions', 0, 'closingProposalIds'], ['unseen']),
    'unseen implicitly rejected alternative', 'PROPOSAL_CHOICE_CONFLICT');
  rejects(parseProposalActionFenceV1,
    changed(acceptFenceFixture, ['applyProposalIds'], []), 'no empty acceptance', 'PROPOSAL_NO_EFFECT');
  rejects(parseProposalActionFenceV1,
    changed(acceptFenceFixture, ['expiresAt'], acceptFenceFixture.issuedAt), 'nonpositive fence lifetime');
  rejects(parseProposalActionFenceV1,
    changed(acceptFenceFixture, ['expiresAt'], acceptFenceFixture.issuedAt + PROPOSAL_GRAPH_LIMITS.fenceLifetimeMs + 1),
    'fence lifetime limit');
  const request = parseProposalActionRequestV1({
    contractVersion: 1,
    fence: acceptFenceFixture,
    fenceToken: 'opaque-approval-token-01234567890123456789',
    idempotencyKey: 'request-accept-p2-0001',
    creation: null,
  });
  assert.equal(request.fence.fenceId, 'fence-p2-v0');
  rejects(parseProposalActionRequestV1, { ...request, idempotencyKey: 'short' }, 'bounded idempotency key');
});

test('PG-S29: unavailable content can be rejected without fabricating candidate proof', () => {
  for (const actionType of ['reject', 'branch_reject']) {
    const rejectFence = {
      ...acceptFenceFixture,
      actionType,
      current: null,
      evaluationId: null,
      effectiveCandidateHash: null,
      applyProposalIds: [],
      choiceResolutions: [],
    };
    const parsed = parseProposalActionFenceV1(rejectFence);
    assert.equal(parsed.actionType, actionType);
    assert.equal(parsed.current, null);
    assert.equal(parsed.effectiveCandidateHash, null);
    rejects(parseProposalActionFenceV1, { ...rejectFence, applyProposalIds: ['p2'] },
      'reject cannot apply hidden proposal content');
  }
  for (const actionType of ['accept', 'batch_accept']) {
    for (const field of ['current', 'evaluationId', 'effectiveCandidateHash']) {
      rejects(parseProposalActionFenceV1,
        changed({ ...acceptFenceFixture, actionType }, [field], null),
        `${actionType} requires ${field}`, 'PROPOSAL_SOURCE_INVALID');
    }
  }
});

test('PG-S03/S19/S24: pending receipt is not success and durable success includes one revision', () => {
  for (const phase of ['prepared', 'applying', 'awaiting_durability', 'recovery_required']) {
    const receipt = parseProposalActionReceiptV1({ ...pendingReceiptFixture, phase });
    assert.equal(receipt.phase, phase);
    assert.equal(receipt.result, null);
    rejects(parseProposalActionReceiptV1,
      { ...pendingReceiptFixture, phase, result: durableReceiptFixture.result },
      `no prematurely finalized result during ${phase}`);
  }
  const receipt = parseProposalActionReceiptV1(durableReceiptFixture);
  assert.equal(receipt.phase, 'succeeded');
  if (receipt.phase !== 'succeeded') assert.fail('Expected durable success');
  assert.equal(receipt.result.kind, 'content_changed');
  assert.equal(receipt.result.revisionId, 'revision-v1');
  assert.deepEqual(receipt.result.resolutions, [
    { proposalId: 'p1', lifecycle: 'included' },
    { proposalId: 'p2', lifecycle: 'applied' },
    { proposalId: 'p3', lifecycle: 'alternative_not_selected' },
  ]);
  rejects(parseProposalActionReceiptV1,
    { ...durableReceiptFixture, operationId: null }, 'durable content result needs operation receipt');
  rejects(parseProposalActionReceiptV1,
    changed(durableReceiptFixture, ['result', 'current', 'revisionId'], 'revision-other'),
    'revision identity must match durable current proof');
  rejects(parseProposalActionReceiptV1,
    changed(durableReceiptFixture, ['result', 'resolutions', 0, 'proposalId'], 'foreign-proposal'),
    'receipt cannot resolve an unrelated proposal');
  rejects(parseProposalActionReceiptV1,
    { ...durableReceiptFixture, fenceToken: 'secret-approval-token' }, 'receipts never store approval tokens');
});

test('PG-S12: satisfied and empty effects cannot be reported as new applied content', () => {
  const satisfied = {
    ...pendingReceiptFixture,
    actionType: 'complete_satisfied',
    affectedProposalIds: ['p2'],
    operationId: null,
    phase: 'succeeded',
    result: {
      kind: 'metadata_only',
      revisionId: null,
      current: currentProofFixture,
      resolutions: [{ proposalId: 'p2', lifecycle: 'satisfied_elsewhere' }],
      createdProposalIds: [],
    },
  };
  const receipt = parseProposalActionReceiptV1(satisfied);
  assert.equal(receipt.phase, 'succeeded');
  if (receipt.phase !== 'succeeded') assert.fail('Expected recorded completion');
  assert.equal(receipt.result.revisionId, null);
  assert.equal(receipt.result.current?.revisionId, 'revision-v0');
  rejects(parseProposalActionReceiptV1,
    changed(satisfied, ['result', 'revisionId'], 'revision-empty'), 'no new revision for an already-present effect');
  for (const lifecycle of ['applied', 'included', 'alternative_not_selected']) {
    rejects(parseProposalActionReceiptV1,
      changed(satisfied, ['result', 'resolutions', 0, 'lifecycle'], lifecycle),
      `metadata cannot claim ${lifecycle}`, 'PROPOSAL_NO_EFFECT');
  }
  rejects(parseProposalActionReceiptV1,
    { ...satisfied, actionType: 'accept' }, 'empty content accept cannot succeed', 'PROPOSAL_NO_EFFECT');
});

test('PG-S19: receipt transition matrix prevents blind re-apply after uncertain durability', () => {
  const transitions = {
    prepared: ['prepared', 'applying', 'succeeded', 'failed'],
    applying: ['applying', 'awaiting_durability', 'recovery_required'],
    awaiting_durability: ['awaiting_durability', 'succeeded', 'recovery_required'],
    recovery_required: ['recovery_required', 'awaiting_durability', 'succeeded', 'failed'],
    succeeded: ['succeeded'],
    failed: ['failed'],
  } as const;
  const phases = ['prepared', 'applying', 'awaiting_durability', 'recovery_required', 'succeeded', 'failed'] as const;
  for (const from of phases) {
    for (const to of phases) {
      const expected = (transitions[from] as readonly string[]).includes(to);
      assert.equal(canTransitionProposalReceiptV1(from, to), expected, `${from} -> ${to}`);
    }
  }
});

test('PG-S33: only fully evidenced untouched legacy operations project as independent roots', () => {
  const projection = projectLegacyProposalV1(legacyEvidenceFixture);
  assert.equal(projection.status, 'safe_independent');
  assert.equal(projection.reason, null);
  assert.equal(projection.reviewRequired, true);
  assert.deepEqual(parseProposalLegacyProjectionV1(projection), projection);
  for (const [field, value, reason] of [
    ['provenance', 'unknown', 'unknown_origin'],
    ['relationshipKnowledge', 'unknown', 'unknown_origin'],
    ['relationshipKnowledge', 'graph_bound', 'graph_bound'],
    ['appliedScope', 'partial', 'partial_operation'],
    ['appliedScope', 'all', 'already_resolved'],
    ['appliedScope', 'unknown', 'unknown_origin'],
    ['source', null, 'missing_evidence'],
    ['remainingPayload', null, 'missing_evidence'],
  ] as const) {
    const blocked = projectLegacyProposalV1({ ...legacyEvidenceFixture, [field]: value });
    assert.equal(blocked.status, 'blocked', field);
    assert.equal(blocked.reason, reason, field);
    assert.equal(blocked.reviewRequired, true);
    rejects(parseProposalLegacyProjectionV1,
      { ...blocked, status: 'safe_independent', reason: null },
      `cannot forge safe migration for ${field}`, 'PROPOSAL_LEGACY_BLOCKED');
  }
  const partial = projectLegacyProposalV1({
    ...legacyEvidenceFixture,
    appliedScope: 'partial',
    appliedPayloadHash: 'b'.repeat(64),
    remainingPayload: { ...legacyEvidenceFixture.remainingPayload, sha256: 'c'.repeat(64) },
    targetScope: {
      ...legacyEvidenceFixture.targetScope,
      appliedTargetIds: ['target-shipping-price'],
      pendingTargetIds: ['target-shipping-insurance'],
    },
  });
  assert.equal(partial.status, 'blocked');
  assert.equal(partial.reason, 'partial_operation');
  assert.deepEqual(partial.evidence.targetScope.appliedTargetIds, ['target-shipping-price']);
  assert.deepEqual(partial.evidence.targetScope.pendingTargetIds, ['target-shipping-insurance']);
  assert.equal(partial.evidence.remainingPayload?.sha256, 'c'.repeat(64));
});

test('PG-S33: legacy terminal, uncertain and late-conflict operations never become fresh roots', () => {
  for (const operationStatus of ['ready', 'needs_review']) {
    assert.equal(projectLegacyProposalV1({ ...legacyEvidenceFixture, operationStatus }).status, 'safe_independent');
  }
  for (const operationStatus of [
    'rejected', 'reverted', 'cancel_requested', 'cancelled', 'superseded', 'expired',
    'failed', 'semantic_conflict', 'persisted_yjs', 'checkpointed_file', 'preparing',
  ]) {
    const projection = projectLegacyProposalV1({ ...legacyEvidenceFixture, operationStatus });
    assert.equal(projection.status, 'blocked', operationStatus);
    assert.equal(projection.reason, 'already_resolved', operationStatus);
  }
  for (const evidence of [
    { ...legacyEvidenceFixture, recoveryStatus: 'uncertain' },
    { ...legacyEvidenceFixture, operationStatus: 'applying' },
    { ...legacyEvidenceFixture, operationStatus: 'applied_to_ydoc' },
  ]) {
    const projection = projectLegacyProposalV1(evidence);
    assert.equal(projection.status, 'blocked');
    assert.equal(projection.reason, 'recovery_uncertain');
  }
  for (const targetScope of [
    { ...legacyEvidenceFixture.targetScope, proof: 'uncertain' },
    { ...legacyEvidenceFixture.targetScope, pendingTargetIds: ['target-shipping-price'] },
  ]) {
    const projection = projectLegacyProposalV1({ ...legacyEvidenceFixture, targetScope });
    assert.equal(projection.status, 'blocked');
    assert.equal(projection.reason, 'missing_evidence');
  }
  rejects(projectLegacyProposalV1,
    changed(legacyEvidenceFixture, ['targetScope', 'appliedTargetIds'], ['target-shipping-price']),
    'applied and pending targets cannot overlap', 'PROPOSAL_SOURCE_INVALID');
  rejects(projectLegacyProposalV1,
    changed(legacyEvidenceFixture, ['targetScope', 'pendingTargetIds'], ['foreign-target']),
    'pending target must belong to original operation', 'PROPOSAL_SOURCE_INVALID');
});

test('PG-S05/S08/S09: replace and detach produce a new explicitly reviewed proposal', () => {
  for (const actionType of ['replace', 'detach']) {
    const detached = actionType === 'detach';
    const creation = {
      contractVersion: 1,
      proposalId: 'new-proposal',
      operationId: 'new-operation',
      scope: rootProposalFixture.scope,
      source: detached ? rootProposalFixture.source : childProposalFixture.source,
      relationships: detached ? rootProposalFixture.relationships : replacementChildFixture.relationships,
      authoredCandidate: replacementChildFixture.authoredCandidate,
      creationKind: detached ? 'detached' : 'replacement',
      detachedFromProposalId: detached ? 'p2' : null,
      reviewRequired: true,
    };
    const request = {
      contractVersion: 1,
      fence: { ...acceptFenceFixture, actionType, applyProposalIds: [], choiceResolutions: [] },
      fenceToken: 'opaque-approval-token-01234567890123456789',
      idempotencyKey: `request-${actionType}-p2-0001`,
      creation,
    };
    assert.equal(parseProposalCreateRequestV1(creation).reviewRequired, true);
    assert.equal(parseProposalActionRequestV1(request).creation?.proposalId, 'new-proposal');
    rejects(parseProposalActionRequestV1, { ...request, creation: null }, `${actionType} requires prepared creation`);
    rejects(parseProposalCreateRequestV1, { ...creation, reviewRequired: false }, 'new proposal always requires review');
    rejects(parseProposalActionRequestV1,
      changed(request, ['creation', detached ? 'detachedFromProposalId' : 'relationships', ...(detached ? [] : ['replacesProposalId'])], 'p3'),
      'new proposal must reference the selected action target', 'PROPOSAL_SOURCE_INVALID');
    const receipt = {
      ...pendingReceiptFixture,
      actionType,
      phase: 'succeeded',
      operationId: null,
      affectedProposalIds: ['p2'],
      result: {
        kind: 'metadata_only', revisionId: null, current: currentProofFixture,
        resolutions: detached ? [] : [{ proposalId: 'p2', lifecycle: 'superseded' }],
        createdProposalIds: ['new-proposal'],
      },
    };
    const parsed = parseProposalActionReceiptV1(receipt);
    assert.equal(parsed.phase, 'succeeded');
    if (parsed.phase !== 'succeeded') assert.fail('Expected creation success');
    assert.deepEqual(parsed.result.createdProposalIds, ['new-proposal']);
    assert.equal(parsed.result.revisionId, null);
    rejects(parseProposalActionReceiptV1,
      changed(receipt, ['result', 'createdProposalIds'], []), 'success must identify its new proposal');
    rejects(parseProposalActionReceiptV1,
      changed(receipt, ['result', 'createdProposalIds'], ['p2']), 'creation cannot reuse old proposal ID');
  }
});

test('PG-S30: structural limits allow their boundary and reject boundary plus one', () => {
  for (const sizeBytes of [0, PROPOSAL_GRAPH_LIMITS.candidateBytes]) {
    const node = parseProposalNodeV1(
      changed(rootProposalFixture, ['authoredCandidate', 'incrementalPayload', 'sizeBytes'], sizeBytes),
    );
    assert.equal(node.authoredCandidate.incrementalPayload.sizeBytes, sizeBytes);
  }
  rejects(parseProposalNodeV1,
    changed(rootProposalFixture, ['authoredCandidate', 'incrementalPayload', 'sizeBytes'], PROPOSAL_GRAPH_LIMITS.candidateBytes + 1),
    'candidate byte upper bound');
  rejects(parseProposalNodeV1,
    { ...rootProposalFixture, padding: 'x'.repeat(PROPOSAL_GRAPH_LIMITS.payloadBytes) },
    'envelope byte limit checked before schema work', 'PROPOSAL_LIMIT_EXCEEDED');

  const nodes = Array.from({ length: PROPOSAL_GRAPH_LIMITS.openRootsPerDocument }, (_, index) => ({
    ...rootProposalFixture, proposalId: `root-${index}`, operationId: `root-operation-${index}`,
  }));
  const graph = { contractVersion: 1, scope: rootProposalFixture.scope, graphRevision: 1, nodes, choiceGroups: [] };
  assert.equal(parseProposalGraphSnapshotV1(graph).nodes.length, 32);
  rejects(parseProposalGraphSnapshotV1, { ...graph, nodes: [...nodes, rootProposalFixture] },
    'open root upper bound', 'PROPOSAL_LIMIT_EXCEEDED');

  const closure = Array.from({ length: PROPOSAL_GRAPH_LIMITS.batchMembers }, (_, index) => ({
    proposalId: `batch-${index}`, casVersion: 1, candidateHash: '8'.repeat(64),
  }));
  const batch = {
    ...acceptFenceFixture,
    actionType: 'batch_accept', closure,
    selectedProposalIds: closure.map((entry) => entry.proposalId),
    applyProposalIds: closure.map((entry) => entry.proposalId), choiceResolutions: [],
  };
  assert.equal(parseProposalActionFenceV1(batch).selectedProposalIds.length, 32);
  rejects(parseProposalActionFenceV1, {
    ...batch,
    closure: [...closure, { proposalId: 'batch-over-limit', casVersion: 1, candidateHash: '8'.repeat(64) }],
    selectedProposalIds: [...batch.selectedProposalIds, 'batch-over-limit'],
    applyProposalIds: [...batch.applyProposalIds, 'batch-over-limit'],
  }, 'batch member upper bound');
});
