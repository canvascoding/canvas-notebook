import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildProposalActionFence,
  hashProposalEvaluationSelectionV1,
  signProposalActionFence,
  type ProposalFenceState,
} from '../app/lib/file-version-center/proposal-action-fence';
import {
  createProposalActionOrchestrator,
  ProposalActionDefinitelyUnappliedError,
} from '../app/lib/file-version-center/proposal-action-orchestrator';
import type { ProposalActionReceiptV1, ProposalCreateRequestV1, ProposalCurrentProofV1, ProposalGraphSnapshotV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalGraphStorageTransaction, ProposalStoredActionRequest } from '../app/lib/file-version-center/proposal-storage';
import type { FileVersionCenterTransaction } from '../app/lib/file-version-center/database';
import { alternativeChildFixture, childProposalFixture, currentProofFixture, proposalScopeFixture, rootProposalFixture } from './fixtures/proposal-graph-contract-v1';

const secret = 'orchestrator-test-signing-secret-32-bytes';
const clock = 1_789_646_400_100;

function graph(): ProposalGraphSnapshotV1 {
  return { contractVersion: 1, scope: proposalScopeFixture, graphRevision: 3,
    nodes: [rootProposalFixture, childProposalFixture, alternativeChildFixture].map((node) => ({ ...node, contractVersion: 1 as const, lifecycle: 'open' as const })) as ProposalGraphSnapshotV1['nodes'],
    choiceGroups: [{ groupId: 'choice-insurance', groupRevision: 1, dependencyProposalId: 'p1', memberProposalIds: ['p2', 'p3'], chosenProposalId: null }],
  };
}

function request(actionType: 'accept' | 'reject' | 'branch_reject' = 'accept') {
  const rejection = actionType === 'reject' || actionType === 'branch_reject';
  const branch = actionType === 'branch_reject';
  const state: ProposalFenceState = {
    scope: proposalScopeFixture, actor: { userId: 'reviewer', actorId: 'reviewer', authorizationRevision: 'access-1' }, actionType,
    current: rejection ? null : currentProofFixture, graphRevision: 3,
    evaluationId: rejection ? null : 'evaluation-p2', effectiveCandidateHash: rejection ? null : 'c'.repeat(64),
    closure: branch ? [{ proposalId: 'p1', casVersion: 1, candidateHash: '8'.repeat(64) }, { proposalId: 'p2', casVersion: 1, candidateHash: 'c'.repeat(64) }, { proposalId: 'p3', casVersion: 1, candidateHash: 'e'.repeat(64) }] : actionType === 'reject' ? [{ proposalId: 'p2', casVersion: 1, candidateHash: 'c'.repeat(64) }] : [
      { proposalId: 'p1', casVersion: 1, candidateHash: '8'.repeat(64) }, { proposalId: 'p2', casVersion: 1, candidateHash: 'c'.repeat(64) }, { proposalId: 'p3', casVersion: 1, candidateHash: 'e'.repeat(64) },
    ],
    selectedProposalIds: branch ? ['p1'] : ['p2'], applyProposalIds: rejection ? [] : ['p1', 'p2'],
    choiceResolutions: rejection ? [] : [{ groupId: 'choice-insurance', groupRevision: 1, chosenProposalId: 'p2', closingProposalIds: ['p3'] }],
  };
  const fence = buildProposalActionFence({ state, fenceId: `fence-${actionType}`, now: clock, expiresAt: clock + 10_000 });
  return { contractVersion: 1 as const, fence, fenceToken: signProposalActionFence(fence, secret), idempotencyKey: `idempotency-${actionType}-0001`, creation: null };
}

function batchRequest(idempotencySuffix = 'default') {
  const state: ProposalFenceState = {
    scope: proposalScopeFixture, actor: { userId: 'reviewer', actorId: 'reviewer', authorizationRevision: 'access-1' }, actionType: 'batch_accept',
    current: currentProofFixture, graphRevision: 3, evaluationId: 'evaluation-p2', effectiveCandidateHash: 'c'.repeat(64),
    closure: [
      { proposalId: 'p1', casVersion: 1, candidateHash: '8'.repeat(64) },
      { proposalId: 'p2', casVersion: 1, candidateHash: 'c'.repeat(64) },
      { proposalId: 'p3', casVersion: 1, candidateHash: 'e'.repeat(64) },
    ],
    selectedProposalIds: ['p1', 'p2'], applyProposalIds: ['p1', 'p2'],
    choiceResolutions: [{ groupId: 'choice-insurance', groupRevision: 1, chosenProposalId: 'p2', closingProposalIds: ['p3'] }],
  };
  const fence = buildProposalActionFence({ state, fenceId: 'fence-batch-accept', now: clock, expiresAt: clock + 10_000 });
  return { contractVersion: 1 as const, fence, fenceToken: signProposalActionFence(fence, secret), idempotencyKey: `idempotency-batch-accept-${idempotencySuffix}`, creation: null };
}

function harness(currentAvailable = true, materializeThrows = false) {
  const snapshot = graph();
  const actions = new Map<string, ProposalActionReceiptV1>();
  const requests = new Map<string, unknown>();
  let applyCalls = 0;
  let recoverCalls = 0;
  let applyFailure = false;
  let recoverFailure = false;
  let applyDefinitelyUnapplied = false;
  let recoverDefinitelyUnapplied = false;
  let evaluationProposalId = 'p2';
  let evaluationSelectionHash: string | undefined;
  let satisfiedEvaluationStatus: 'satisfied_elsewhere' | 'empty_effect' | 'clean' = 'satisfied_elsewhere';
  const transaction = {
    loadGraph: async () => structuredClone(snapshot),
    getEvaluation: async (id: string) => id === 'evaluation-p2' || id === 'satisfied-p2' ? { contractVersion: 1, evaluationId: id, proposalId: evaluationProposalId, scope: proposalScopeFixture,
      current: currentProofFixture, graphRevision: 3, status: id === 'satisfied-p2' ? satisfiedEvaluationStatus : 'clean', reasonCode: null, effectiveCandidate: { ref: 'effective', sha256: 'c'.repeat(64), sizeBytes: 1, encoding: 'yjs_full_update_v1' },
      anchorMap: { ref: 'anchors', sha256: 'a'.repeat(64), sizeBytes: 1 }, effectPreconditions: { ref: 'proof', sha256: 'b'.repeat(64), sizeBytes: 1 }, selectionHash: evaluationSelectionHash, evaluatedAt: clock, expiresAt: clock + 10_000 } : null,
    readArtifact: async () => new Uint8Array([1]),
    reserveAction: async (receipt: ProposalActionReceiptV1, stored: unknown) => {
      for (const prior of actions.values()) {
        if (prior.actorId === receipt.actorId && prior.idempotencyKeyHash === receipt.idempotencyKeyHash) {
          if (prior.requestDigest !== receipt.requestDigest) throw new Error('PROPOSAL_IDEMPOTENCY_MISMATCH');
          return prior;
        }
      }
      actions.set(receipt.actionId, receipt); requests.set(receipt.actionId, stored); return receipt;
    },
    getAction: async (id: string) => actions.get(id) ?? null,
    getActionRequest: async (id: string) => requests.get(id) as ProposalStoredActionRequest | undefined ?? null,
    advanceAction: async (receipt: ProposalActionReceiptV1) => { actions.set(receipt.actionId, receipt); },
    transitionProposal: async (id: string, cas: number, lifecycle: string) => {
      const node = snapshot.nodes.find((candidate) => candidate.proposalId === id)!;
      assert.equal(node.casVersion, cas); node.lifecycle = lifecycle as typeof node.lifecycle; node.casVersion++;
      snapshot.graphRevision++;
      return node;
    },
    putChoiceGroup: async (group: ProposalGraphSnapshotV1['choiceGroups'][number]) => {
      snapshot.choiceGroups = snapshot.choiceGroups.map((candidate) => candidate.groupId === group.groupId ? group : candidate);
      snapshot.graphRevision++;
    },
    insertProposal: async (node: ProposalGraphSnapshotV1['nodes'][number]) => { snapshot.nodes.push(node); return node; },
    bindRevision: async () => {},
  } as unknown as ProposalGraphStorageTransaction;
  const orchestrator = createProposalActionOrchestrator({
    withLockedGraph: async (_scope, _options, action) => action(transaction, {} as FileVersionCenterTransaction),
    authorize: async () => ({ userId: 'reviewer', actorId: 'reviewer', authorizationRevision: 'access-1' }),
    readCurrent: async () => {
      if (!currentAvailable) throw new Error('document bytes unavailable');
      return currentProofFixture;
    },
    prepareDurably: async () => {},
    applyDurably: async (input) => {
      assert.equal(input.candidate.evaluation.evaluationId, 'evaluation-p2');
      assert.deepEqual(input.candidate.update, new Uint8Array([1]));
      applyCalls++;
      if (applyDefinitelyUnapplied) {
        throw new ProposalActionDefinitelyUnappliedError('PROPOSAL_CURRENT_CHANGED', 'simulated current change before mutation');
      }
      if (applyFailure) throw new Error('simulated lost durable response');
      return { operationId: input.actionId, revisionId: 'revision-v1', current: { ...currentProofFixture, revisionId: 'revision-v1' } as ProposalCurrentProofV1 };
    },
    recoverDurably: async (input) => {
      recoverCalls++;
      if (recoverDefinitelyUnapplied) {
        throw new ProposalActionDefinitelyUnappliedError('PROPOSAL_NO_EFFECT', 'simulated crash before mutation');
      }
      if (recoverFailure) throw Object.assign(new Error('durability cannot be proven'), { code: 'PROPOSAL_RECOVERY_REQUIRED' });
      return { operationId: input.actionId, revisionId: 'revision-v1', current: { ...currentProofFixture, revisionId: 'revision-v1' } as ProposalCurrentProofV1 };
    },
    materializeCreation: async ({ creation, actorId, now }) => {
      if (materializeThrows) throw new Error('creation transaction failed');
      return { ...creation, lifecycle: 'open', casVersion: 1, createdAt: now, createdByActorId: actorId };
    }, signingSecret: secret, now: () => clock, createId: (() => { let id = 0; return () => `action-${++id}`; })(),
  });
  return { orchestrator, state: () => snapshot, applies: () => applyCalls, recoveries: () => recoverCalls,
    failApply: () => { applyFailure = true; }, failRecovery: () => { recoverFailure = true; },
    failApplyBeforeMutation: () => { applyDefinitelyUnapplied = true; },
    failRecoveryBeforeMutation: () => { recoverDefinitelyUnapplied = true; },
    setEvaluationProposalId: (proposalId: string) => { evaluationProposalId = proposalId; },
    setEvaluationSelectionHash: (selectionHash: string | undefined) => { evaluationSelectionHash = selectionHash; },
    setSatisfiedEvaluationStatus: (status: typeof satisfiedEvaluationStatus) => { satisfiedEvaluationStatus = status; },
    action: (id: string) => actions.get(id) ?? null };
}

test('accept applies the exact dependency closure once, closes its alternative and binds one durable revision', async () => {
  const h = harness(); const approved = await h.orchestrator.execute(request());
  assert.equal(approved.phase, 'succeeded');
  assert.equal(approved.result?.kind, 'content_changed');
  assert.equal(approved.result?.revisionId, 'revision-v1');
  assert.deepEqual(approved.result?.resolutions, [
    { proposalId: 'p1', lifecycle: 'included' }, { proposalId: 'p2', lifecycle: 'applied' }, { proposalId: 'p3', lifecycle: 'alternative_not_selected' },
  ]);
  assert.equal(h.applies(), 1);
  assert.deepEqual(h.state().nodes.map((node) => node.lifecycle), ['included', 'applied', 'alternative_not_selected']);
});

test('a completed identical retry returns its receipt without a second durable apply', async () => {
  const h = harness(); const first = await h.orchestrator.execute(request()); const retry = await h.orchestrator.execute(request());
  assert.deepEqual(retry, first); assert.equal(h.applies(), 1);
});

test('restart recovery finalizes durable evidence exactly once and never replays live apply', async () => {
  const h = harness();
  h.failApply();
  await assert.rejects(h.orchestrator.execute(request()), { code: 'PROPOSAL_RECOVERY_REQUIRED' });
  assert.equal(h.action('action-1')?.phase, 'recovery_required');
  assert.deepEqual(h.state().nodes.map((node) => node.lifecycle), ['open', 'open', 'open']);
  const recovered = await h.orchestrator.recover(proposalScopeFixture, 'action-1');
  assert.equal(recovered.phase, 'succeeded');
  assert.equal(h.applies(), 1);
  assert.equal(h.recoveries(), 1);
  assert.deepEqual(h.state().nodes.map((node) => node.lifecycle), ['included', 'applied', 'alternative_not_selected']);
  assert.deepEqual(await h.orchestrator.recover(proposalScopeFixture, 'action-1'), recovered);
  assert.equal(h.recoveries(), 1);
});

test('restart recovery leaves the graph reserved when durable state cannot be proven', async () => {
  const h = harness();
  h.failApply(); h.failRecovery();
  await assert.rejects(h.orchestrator.execute(request()), { code: 'PROPOSAL_RECOVERY_REQUIRED' });
  await assert.rejects(h.orchestrator.recover(proposalScopeFixture, 'action-1'), { code: 'PROPOSAL_RECOVERY_REQUIRED' });
  assert.equal(h.action('action-1')?.phase, 'recovery_required');
  assert.deepEqual(h.state().nodes.map((node) => node.lifecycle), ['open', 'open', 'open']);
});

test('a proven pre-mutation apply failure releases the graph without resolving proposals', async () => {
  const h = harness(); h.failApplyBeforeMutation();
  const failed = await h.orchestrator.execute(request());
  assert.equal(failed.phase, 'failed'); assert.equal(failed.errorCode, 'PROPOSAL_CURRENT_CHANGED');
  assert.deepEqual(h.state().nodes.map((node) => node.lifecycle), ['open', 'open', 'open']);
  assert.equal(h.applies(), 1); assert.equal(h.recoveries(), 0);
});

test('restart recovery releases an action proven to have stopped before mutation', async () => {
  const h = harness(); h.failApply(); h.failRecoveryBeforeMutation();
  await assert.rejects(h.orchestrator.execute(request()), { code: 'PROPOSAL_RECOVERY_REQUIRED' });
  const failed = await h.orchestrator.recover(proposalScopeFixture, 'action-1');
  assert.equal(failed.phase, 'failed'); assert.equal(failed.errorCode, 'PROPOSAL_NO_EFFECT');
  assert.deepEqual(h.state().nodes.map((node) => node.lifecycle), ['open', 'open', 'open']);
  assert.equal(h.recoveries(), 1);
});

test('a stale closure fence fails before live apply and leaves the graph unresolved', async () => {
  const h = harness(); const stale = request(); stale.fence.graphRevision++;
  await assert.rejects(h.orchestrator.execute(stale), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error));
  assert.equal(h.applies(), 0); assert.deepEqual(h.state().nodes.map((node) => node.lifecycle), ['open', 'open', 'open']);
});

test('a legacy single-proposal evaluation cannot be reused for a different proposal', async () => {
  const h = harness();
  h.setEvaluationProposalId('p1');
  await assert.rejects(h.orchestrator.execute(request()), { code: 'PROPOSAL_CANDIDATE_CHANGED' });
  assert.equal(h.applies(), 0);
});

test('batch accept rejects an unbound legacy evaluation before durable apply', async () => {
  const h = harness();
  await assert.rejects(h.orchestrator.execute(batchRequest()), { code: 'PROPOSAL_CANDIDATE_CHANGED' });
  assert.equal(h.applies(), 0);
});

test('batch accept requires a selection hash for the exact selected closure and apply set', async () => {
  const h = harness();
  h.setEvaluationSelectionHash(hashProposalEvaluationSelectionV1({
    selectedProposalIds: ['p1', 'p3'], closureProposalIds: ['p1', 'p3'], applyProposalIds: ['p1', 'p3'], graphRevision: 3,
  }));
  await assert.rejects(h.orchestrator.execute(batchRequest()), { code: 'PROPOSAL_CANDIDATE_CHANGED' });
  assert.equal(h.applies(), 0);

  h.setEvaluationSelectionHash(hashProposalEvaluationSelectionV1({
    selectedProposalIds: ['p1', 'p2'], closureProposalIds: ['p1', 'p2', 'p3'], applyProposalIds: ['p1', 'p2'], graphRevision: 3,
  }));
  const accepted = await h.orchestrator.execute(batchRequest('valid-selection'));
  assert.equal(accepted.phase, 'succeeded');
  assert.equal(h.applies(), 1);
});

test('single reject changes only the selected proposal and never applies document content', async () => {
  const h = harness(false); const rejected = await h.orchestrator.execute(request('reject'));
  assert.equal(rejected.phase, 'succeeded'); assert.equal(rejected.result?.kind, 'metadata_only');
  assert.deepEqual(h.state().nodes.map((node) => node.lifecycle), ['open', 'rejected', 'open']); assert.equal(h.applies(), 0);
});

test('branch reject propagates deterministically to dependency descendants, never to independent nodes', async () => {
  const h = harness(); const rejected = await h.orchestrator.execute(request('branch_reject'));
  assert.equal(rejected.phase, 'succeeded');
  assert.deepEqual(h.state().nodes.map((node) => node.lifecycle), ['rejected', 'rejected', 'rejected']); assert.equal(h.applies(), 0);
});

function metadataRequest(actionType: 'replace' | 'detach' | 'complete_satisfied' | 'rebase', creation: ProposalCreateRequestV1 | null = null) {
  const state: ProposalFenceState = {
    scope: proposalScopeFixture, actor: { userId: 'reviewer', actorId: 'reviewer', authorizationRevision: 'access-1' }, actionType,
    current: currentProofFixture, graphRevision: 3, evaluationId: actionType === 'complete_satisfied' ? 'satisfied-p2' : null,
    effectiveCandidateHash: actionType === 'complete_satisfied' ? 'c'.repeat(64) : null,
    closure: [{ proposalId: 'p2', casVersion: 1, candidateHash: 'c'.repeat(64) }], selectedProposalIds: ['p2'], applyProposalIds: [], choiceResolutions: [],
  };
  const fence = buildProposalActionFence({ state, fenceId: `fence-${actionType}`, now: clock, expiresAt: clock + 10_000, creation });
  return { contractVersion: 1 as const, fence, fenceToken: signProposalActionFence(fence, secret), idempotencyKey: `idempotency-${actionType}-0001`, creation };
}

const replacementCreation = {
  contractVersion: 1 as const, proposalId: 'replacement-new', operationId: 'operation-replacement-new', scope: proposalScopeFixture,
  source: childProposalFixture.source, relationships: { ...childProposalFixture.relationships, replacesProposalId: 'p2' },
  authoredCandidate: childProposalFixture.authoredCandidate, creationKind: 'replacement' as const, detachedFromProposalId: null, reviewRequired: true as const,
} as unknown as ProposalCreateRequestV1;

const detachedCreation = {
  contractVersion: 1 as const, proposalId: 'detached-new', operationId: 'operation-detached-new', scope: proposalScopeFixture,
  source: rootProposalFixture.source, relationships: rootProposalFixture.relationships, authoredCandidate: rootProposalFixture.authoredCandidate,
  creationKind: 'detached' as const, detachedFromProposalId: 'p2', reviewRequired: true as const,
} as unknown as ProposalCreateRequestV1;

test('replace and detach create the exact prepared proposal atomically', async () => {
  const replaceHarness = harness();
  const replaced = await replaceHarness.orchestrator.execute(metadataRequest('replace', replacementCreation));
  assert.deepEqual(replaced.result?.createdProposalIds, ['replacement-new']);
  const detachHarness = harness();
  const detached = await detachHarness.orchestrator.execute(metadataRequest('detach', detachedCreation));
  assert.deepEqual(detached.result?.createdProposalIds, ['detached-new']);
});

test('complete_satisfied requires and records the satisfied evaluation', async () => {
  const h = harness();
  const completed = await h.orchestrator.execute(metadataRequest('complete_satisfied'));
  assert.equal(completed.result?.resolutions[0]?.lifecycle, 'satisfied_elsewhere');

  const empty = harness();
  empty.setSatisfiedEvaluationStatus('empty_effect');
  const completedEmpty = await empty.orchestrator.execute(metadataRequest('complete_satisfied'));
  assert.equal(completedEmpty.result?.resolutions[0]?.lifecycle, 'satisfied_elsewhere');

  const wrong = harness();
  wrong.setSatisfiedEvaluationStatus('clean');
  await assert.rejects(wrong.orchestrator.execute(metadataRequest('complete_satisfied')), {
    code: 'PROPOSAL_CANDIDATE_CHANGED',
  });
});

test('a changed choice group is rejected before apply', async () => {
  const h = harness();
  h.state().choiceGroups[0]!.groupRevision = 2;
  await assert.rejects(h.orchestrator.execute(request()), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error));
  assert.equal(h.applies(), 0);
});

test('creation failure leaves the graph unresolved', async () => {
  const h = harness(true, true);
  await assert.rejects(h.orchestrator.execute(metadataRequest('replace', replacementCreation)), /creation transaction failed/);
  assert.deepEqual(h.state().nodes.map((node) => node.lifecycle), ['open', 'open', 'open']);
});

test('rebase is explicitly unavailable instead of succeeding as a no-op', async () => {
  const h = harness();
  const value = metadataRequest('rebase');
  await assert.rejects(h.orchestrator.execute(value), { code: 'PROPOSAL_UPGRADE_REQUIRED' });
});
