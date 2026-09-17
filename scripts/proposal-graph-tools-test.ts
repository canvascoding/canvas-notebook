import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { Y } from '../app/lib/collaboration/server-runtime';
import { createAgentTextTarget, type AgentTextTarget } from '../app/lib/collaboration/agent-operations';
import {
  ProposalGraphContractError,
  type ProposalArtifactReferenceV1,
  type ProposalChoiceGroupV1,
  type ProposalDocumentScopeV1,
  type ProposalEvaluationV1,
  type ProposalNodeV1,
  type ProposalRelationshipsV1,
} from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { ProposalToolEditV1 } from '../app/lib/file-version-center/contracts/proposal-tools-v1';
import { createProposalProvenanceService } from '../app/lib/file-version-center/proposal-provenance-service';
import type { ProposalGraphStorageTransaction, ProposalStoredArtifact } from '../app/lib/file-version-center/proposal-storage';
import { asAgentFileToolError, asAgentFileToolSuccess } from '../app/lib/pi/agent-file-tool-results';
import type { AgentFileChangeResult } from '../app/lib/pi/agent-file-operations';

const scope: ProposalDocumentScopeV1 = {
  workspaceId: 'tool-workspace', lineageId: 'tool-lineage', documentId: 'tool-document',
  lifecycleGeneration: 1, schemaVersion: 1,
};
const baseContent = 'Kosten: 10 EUR\nLieferzeit: 5 Tage\n';
const parentContent = 'Kosten: 12 EUR\nLieferzeit: 5 Tage\nVersicherung: 100 EUR\n';
const childContent = 'Kosten: 12 EUR\nLieferzeit: 5 Tage\nVersicherung: 150 EUR\n';
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);

function expectedCode(code: string) {
  return (error: unknown) => error instanceof ProposalGraphContractError && error.code === code;
}

function targetsFor(update: Uint8Array, search: string, replacement: string): AgentTextTarget[] {
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, update);
    const text = doc.getText('content');
    const start = text.toString().indexOf(search);
    assert.ok(start >= 0, `The exact source must contain ${JSON.stringify(search)}`);
    return [createAgentTextTarget({ text, from: start, to: start + search.length, replacement,
      targetId: 'edit-target', groupId: 'edit-group' })];
  } finally { doc.destroy(); }
}

/**
 * A rollback-accounting adapter, not a PostgreSQL atomicity claim. Production
 * transaction tests separately prove that the unit uses one real connection.
 * Candidate construction and Yjs identities here are real, not string mocks.
 */
function harness() {
  const live = new Y.Doc({ gc: false });
  live.clientID = 1234;
  live.getText('content').insert(0, baseContent);
  const stored = {
    nodes: new Map<string, ProposalNodeV1>(), groups: new Map<string, ProposalChoiceGroupV1>(),
    evaluations: new Map<string, ProposalEvaluationV1>(),
    artifacts: new Map<string, { ref: ProposalStoredArtifact; bytes: Uint8Array }>(),
    operations: new Map<string, { operationId: string; proposalId: string; requestDigest: string;
      authoredRelationships: ProposalRelationshipsV1 | null }>(),
    revision: 0,
  };
  const controls = {
    denyRead: new Set<string>(), denyCreate: false, denyManage: false,
    failInsertProposal: false, failInsertOperation: false,
    buildCalls: 0, lookups: 0, transactionId: 0, activeTransactionId: 0,
    events: [] as Array<{ action: string; transactionId: number }>,
    authorizations: [] as Array<{ action: string; proposalIds: readonly string[] }>,
  };
  let serial = 0;
  let graphChanged = false;
  const event = (action: string) => {
    assert.notEqual(controls.activeTransactionId, 0, `${action} must share the enclosing transaction`);
    controls.events.push({ action, transactionId: controls.activeTransactionId });
  };
  const unavailable = () => { throw new Error('Unexpected graph operation in provenance-only fixture'); };
  const graph: ProposalGraphStorageTransaction = {
    loadGraph: async () => ({ contractVersion: 1, scope: clone(scope), graphRevision: stored.revision,
      nodes: [...stored.nodes.values()].map(clone), choiceGroups: [...stored.groups.values()].map(clone) }),
    getProposal: async (id) => clone(stored.nodes.get(id) ?? null),
    putArtifact: async (encoding, payload) => {
      event('artifact');
      const digest = sha256(payload);
      const ref = { ref: `artifact-${digest}`, sha256: digest, sizeBytes: payload.byteLength, encoding };
      stored.artifacts.set(ref.ref, { ref, bytes: new Uint8Array(payload) });
      return clone(ref);
    },
    readArtifact: async (ref: ProposalArtifactReferenceV1) => {
      const record = stored.artifacts.get(ref.ref);
      if (!record || record.ref.sha256 !== ref.sha256 || record.ref.sizeBytes !== ref.sizeBytes) {
        throw new ProposalGraphContractError('PROPOSAL_CONTENT_UNAVAILABLE', 'Fixture artifact is unavailable');
      }
      return new Uint8Array(record.bytes);
    },
    insertProposal: async (node) => {
      event('proposal');
      if (controls.failInsertProposal) throw new Error('Injected node failure');
      assert.ok(!stored.nodes.has(node.proposalId));
      const operation = [...stored.operations.values()].find((entry) => entry.operationId === node.operationId);
      assert.ok(operation, 'operation must exist in this transaction before its FK-bound node');
      operation.authoredRelationships = clone(node.relationships);
      stored.nodes.set(node.proposalId, clone(node)); graphChanged = true; return clone(node);
    },
    transitionProposal: async (id, casVersion, lifecycle) => {
      event('transition');
      const node = stored.nodes.get(id)!;
      assert.equal(node.casVersion, casVersion);
      const next = { ...node, casVersion: casVersion + 1, lifecycle };
      stored.nodes.set(id, next); graphChanged = true; return clone(next);
    },
    putChoiceGroup: async (choice) => { event('choice'); stored.groups.set(choice.groupId, clone(choice)); graphChanged = true; },
    getEvaluation: async (id) => clone(stored.evaluations.get(id) ?? null),
    putEvaluation: async (evaluation) => { stored.evaluations.set(evaluation.evaluationId, clone(evaluation)); },
    reserveAction: unavailable, getAction: unavailable, getActionRequest: unavailable, advanceAction: unavailable,
    bindRevision: unavailable, collectArtifacts: unavailable,
  };
  const service = createProposalProvenanceService({
    now: () => 1000,
    createId: () => `generated-${++serial}`,
    authorize: async ({ scope: actualScope, action, proposalIds }) => {
      assert.deepEqual(actualScope, scope);
      controls.authorizations.push({ action, proposalIds: [...proposalIds] });
      if ((action === 'create' && controls.denyCreate) || (action === 'manage_relationship' && controls.denyManage)
        || (action === 'read' && proposalIds.some((id) => controls.denyRead.has(id)))) {
        throw new ProposalGraphContractError('PROPOSAL_ACCESS_DENIED', 'Fixture access denied');
      }
    },
    withTransaction: async (actualScope, action) => {
      assert.deepEqual(actualScope, scope);
      const before = clone(stored);
      assert.equal(controls.activeTransactionId, 0);
      controls.activeTransactionId = ++controls.transactionId;
      graphChanged = false;
      try {
        const result = await action({
          graph,
          loadCurrent: async () => ({ scope: clone(scope), representation: 'plain_text', revisionId: 'revision-v0', update: Y.encodeStateAsUpdate(live) }),
          lookupOperation: async ({ idempotencyKey, requestDigest }) => {
            event('lookup'); controls.lookups++;
            const operation = stored.operations.get(idempotencyKey);
            if (operation && operation.requestDigest !== requestDigest) throw new ProposalGraphContractError('PROPOSAL_IDEMPOTENCY_MISMATCH', 'Different request');
            if (!operation) return null;
            assert.ok(operation.authoredRelationships, 'durable retry uses the immutable insertion record');
            return { operationId: operation.operationId, proposalId: operation.proposalId,
              authoredRelationships: clone(operation.authoredRelationships) };
          },
          insertPreparedOperation: async (input) => {
            event('operation');
            if (controls.failInsertOperation) throw new Error('Injected operation failure');
            assert.deepEqual(input.scope, scope);
            assert.equal(input.representation, 'plain_text');
            assert.equal(input.reviewRequired, true, 'explicit graph creation never activates Safe-Direct');
            assert.ok(!stored.operations.has(input.idempotencyKey));
            stored.operations.set(input.idempotencyKey, { operationId: input.operationId,
              proposalId: input.proposalId, requestDigest: input.requestDigest, authoredRelationships: null });
          },
        });
        if (graphChanged) stored.revision++;
        return result;
      } catch (error) {
        Object.assign(stored, before);
        throw error;
      } finally { controls.activeTransactionId = 0; }
    },
  });
  const readCurrent = () => service.readExact({ scope, proposalId: null });
  const readProposal = (proposalId: string) => service.readExact({ scope, proposalId });
  const intent = (source: ProposalToolEditV1['source']): ProposalToolEditV1 => ({
    contractVersion: 1, creationKind: source.kind === 'proposal' ? 'extends' : 'independent', source,
    expectedParentCandidateHash: source.kind === 'proposal' ? source.candidateHash : null,
    expectedParentCasVersion: source.kind === 'proposal' ? source.proposalCasVersion : null,
    replaces: null, choice: null,
  });
  const create = (proposal: ProposalToolEditV1, idempotencyKey: string, search: string, replacement: string) => service.create({
    scope, actorId: 'agent', idempotencyKey: `tool-test-${idempotencyKey}`, proposal,
    mutation: { tool: 'edit_file', oldText: search, newText: replacement },
    buildTargets: ({ update }) => { controls.buildCalls++; return targetsFor(update, search, replacement); },
  });
  const parent = async () => {
    const read = await readCurrent();
    return create(intent(read.metadata.source), 'parent-request', baseContent, parentContent);
  };
  return { live, stored, controls, service, graph, intent, create, parent, readCurrent, readProposal, close: () => live.destroy() };
}

test('PG-S13/S31 explicit proposal read supplies exact parent candidate, not authoritative content', async () => {
  const h = harness();
  try {
    const parent = await h.parent();
    assert.equal(parent.proposal.reviewRequired, true);
    assert.equal(parent.proposal.source.kind, 'authoritative', 'creation result identifies its authoring base, not a fresh child source');
    const read = await h.readProposal(parent.node.proposalId);
    assert.equal(read.content, parentContent);
    assert.equal(read.metadata.contentSha256, sha256(parentContent));
    assert.equal(read.metadata.source.kind, 'proposal');
    assert.equal(read.metadata.source.snapshot.sha256, parent.node.authoredCandidate.cumulativeCandidate.sha256);
    assert.equal(h.live.getText('content').toString(), baseContent);
    const child = await h.create(h.intent(read.metadata.source), 'child-request', '100 EUR', '150 EUR');
    assert.equal(child.node.relationships.dependency?.proposalId, parent.node.proposalId);
    assert.equal(child.proposal.reviewRequired, true);
    const childRead = await h.readProposal(child.node.proposalId);
    assert.equal(childRead.content, childContent);
    assert.equal((await h.readCurrent()).content, baseContent, 'normal read never includes pending edits');
    assert.equal(h.live.getText('content').toString(), baseContent);
    assert.equal(h.stored.operations.size, 2);
    assert.equal(h.stored.nodes.size, 2);
  } finally { h.close(); }
});

test('PG-S18 identical retry reuses original candidate and does not rebuild or create another operation', async () => {
  const h = harness();
  try {
    const read = await h.readCurrent();
    const proposal = h.intent(read.metadata.source);
    const first = await h.create(proposal, 'same-request', baseContent, parentContent);
    const second = await h.create(proposal, 'same-request', baseContent, parentContent);
    assert.equal(second.reused, true);
    assert.equal(second.node.proposalId, first.node.proposalId);
    assert.equal(second.node.operationId, first.node.operationId);
    assert.equal(second.node.authoredCandidate.cumulativeCandidate.sha256, first.node.authoredCandidate.cumulativeCandidate.sha256);
    assert.equal(h.controls.buildCalls, 1);
    assert.equal(h.stored.nodes.size, 1);
    assert.equal(h.stored.operations.size, 1);
    await assert.rejects(h.create(proposal, 'same-request', baseContent, 'Different'), expectedCode('PROPOSAL_IDEMPOTENCY_MISMATCH'));
    assert.equal(h.controls.buildCalls, 1);
  } finally { h.close(); }
});

test('PG-S10 fresh exact read pins a clean-rebased parent candidate including unrelated current edits', async () => {
  const h = harness();
  try {
    const base = await h.readCurrent();
    const parent = await h.create(h.intent(base.metadata.source), 'price-change-request', '10 EUR', '12 EUR');
    const stale = await h.readProposal(parent.node.proposalId);
    h.live.getText('content').insert(h.live.getText('content').length, 'Neue Notiz.\n');
    await assert.rejects(h.create(h.intent(stale.metadata.source), 'stale-rebased-child', '12 EUR', '14 EUR'), expectedCode('PROPOSAL_CURRENT_CHANGED'));
    const fresh = await h.readProposal(parent.node.proposalId);
    assert.equal(fresh.content, 'Kosten: 12 EUR\nLieferzeit: 5 Tage\nNeue Notiz.\n');
    assert.equal(fresh.metadata.source.kind, 'proposal');
    if (fresh.metadata.source.kind !== 'proposal') throw new Error('Expected proposal');
    assert.equal(fresh.metadata.source.authoredCandidateHash, parent.node.authoredCandidate.cumulativeCandidate.sha256);
    assert.notEqual(fresh.metadata.source.candidateHash, fresh.metadata.source.authoredCandidateHash);
    assert.ok(fresh.metadata.source.evaluationId);
    const child = await h.create(h.intent(fresh.metadata.source), 'fresh-rebased-child', '12 EUR', '14 EUR');
    assert.equal((await h.readProposal(child.node.proposalId)).content, 'Kosten: 14 EUR\nLieferzeit: 5 Tage\nNeue Notiz.\n');
    assert.equal(h.live.getText('content').toString(), `${baseContent}Neue Notiz.\n`);
  } finally { h.close(); }
});

test('operation and graph node creation use the same transaction and either both commit or neither does', async () => {
  for (const failedStep of ['operation', 'proposal'] as const) {
    const h = harness();
    try {
      const read = await h.readCurrent();
      const beforeArtifacts = h.stored.artifacts.size;
      h.controls.failInsertOperation = failedStep === 'operation';
      h.controls.failInsertProposal = failedStep === 'proposal';
      await assert.rejects(h.create(h.intent(read.metadata.source), 'atomic-request', baseContent, parentContent), /Injected/);
      assert.equal(h.stored.operations.size, 0, 'no legacy-visible orphan operation');
      assert.equal(h.stored.nodes.size, 0, 'no graph node without its operation');
      assert.equal(h.stored.revision, 0);
      assert.equal(h.stored.artifacts.size, beforeArtifacts, 'failed creation leaves no unreferenced candidate artifacts');
      const writeTransactions = new Set(h.controls.events.filter((event) => ['operation', 'proposal'].includes(event.action)).map((event) => event.transactionId));
      assert.equal(writeTransactions.size, 1);
      assert.equal(h.live.getText('content').toString(), baseContent);
    } finally { h.close(); }
  }
});

test('PG-S31 missing parent, changed CAS/hash and unavailable snapshot never fall back to independent creation', async () => {
  for (const scenario of ['missing', 'cas', 'candidate', 'snapshot'] as const) {
    const h = harness();
    try {
      const parent = await h.parent();
      const read = await h.readProposal(parent.node.proposalId);
      const proposal = h.intent(read.metadata.source);
      const storedParent = h.stored.nodes.get(parent.node.proposalId)!;
      if (scenario === 'missing') h.stored.nodes.delete(parent.node.proposalId);
      if (scenario === 'cas') storedParent.casVersion++;
      if (scenario === 'candidate') storedParent.authoredCandidate.cumulativeCandidate.sha256 = 'f'.repeat(64);
      if (scenario === 'snapshot') h.stored.artifacts.delete(read.metadata.source.snapshot.ref);
      const beforeNodes = h.stored.nodes.size;
      await assert.rejects(h.create(proposal, 'stale-child', '100 EUR', '150 EUR'), expectedCode(
        scenario === 'snapshot' ? 'PROPOSAL_CONTENT_UNAVAILABLE' : 'PROPOSAL_PARENT_CHANGED',
      ));
      assert.equal(h.stored.nodes.size, beforeNodes);
      assert.equal(h.stored.operations.size, 1);
      assert.equal(h.controls.buildCalls, 1, 'invalid source fails before authoring the child');
      assert.equal(h.live.getText('content').toString(), baseContent);
    } finally { h.close(); }
  }
});

test('PG-S25 read denial of parent prevents descendant source disclosure and creation', async () => {
  const h = harness();
  try {
    const parent = await h.parent();
    const read = await h.readProposal(parent.node.proposalId);
    h.controls.denyRead.add(parent.node.proposalId);
    await assert.rejects(h.readProposal(parent.node.proposalId), expectedCode('PROPOSAL_ACCESS_DENIED'));
    await assert.rejects(h.create(h.intent(read.metadata.source), 'denied-child', '100 EUR', '150 EUR'), expectedCode('PROPOSAL_ACCESS_DENIED'));
    assert.equal(h.controls.buildCalls, 1);
    assert.equal(h.stored.nodes.size, 1);
    assert.equal(h.stored.operations.size, 1);
  } finally { h.close(); }
});

test('PG-S23 forged source scope cannot move a proposal across workspace, document, lifecycle or schema', async () => {
  const h = harness();
  try {
    const read = await h.readCurrent();
    for (const field of ['workspaceId', 'lineageId', 'documentId', 'lifecycleGeneration', 'schemaVersion'] as const) {
      const source = clone(read.metadata.source);
      Object.assign(source.scope, { [field]: typeof source.scope[field] === 'string' ? 'foreign' : 2 });
      await assert.rejects(h.create(h.intent(source), `forged-${field}`, baseContent, parentContent), expectedCode(
        field === 'lifecycleGeneration' || field === 'schemaVersion' ? 'PROPOSAL_STALE_LIFECYCLE' : 'PROPOSAL_SCOPE_MISMATCH',
      ));
    }
    assert.equal(h.controls.buildCalls, 0);
    assert.equal(h.stored.nodes.size, 0);
    assert.equal(h.stored.operations.size, 0);
  } finally { h.close(); }
});

test('PG-S10/S31 evaluation identity, graph revision and expiry are checked before child preparation', async () => {
  for (const scenario of ['missing', 'proposal', 'graph', 'expired', 'candidate', 'current'] as const) {
    const h = harness();
    try {
      const parent = await h.parent();
      const read = await h.readProposal(parent.node.proposalId);
      assert.equal(read.metadata.source.kind, 'proposal');
      if (read.metadata.source.kind !== 'proposal') throw new Error('Expected proposal');
      const id = read.metadata.source.evaluationId!;
      const evaluation = h.stored.evaluations.get(id)!;
      if (scenario === 'missing') h.stored.evaluations.delete(id);
      if (scenario === 'proposal') evaluation.proposalId = 'another-proposal';
      if (scenario === 'graph') evaluation.graphRevision++;
      if (scenario === 'expired') evaluation.expiresAt = 1000;
      if (scenario === 'candidate') evaluation.effectiveCandidate!.sha256 = 'f'.repeat(64);
      if (scenario === 'current') evaluation.current.deleteSetHash = 'f'.repeat(64);
      await assert.rejects(h.create(h.intent(read.metadata.source), `evaluation-${scenario}`, '100 EUR', '150 EUR'), expectedCode('PROPOSAL_PARENT_CHANGED'));
      assert.equal(h.controls.buildCalls, 1);
      assert.equal(h.stored.nodes.size, 1);
      assert.equal(h.stored.operations.size, 1);
    } finally { h.close(); }
  }
});

test('PG-S16 delete-only current changes invalidate both authoritative and derived authoring sources', async () => {
  for (const derived of [false, true]) {
    const h = harness();
    try {
      const read = derived ? await h.readProposal((await h.parent()).node.proposalId) : await h.readCurrent();
      const vector = Y.encodeStateVector(h.live);
      h.live.getText('content').delete(0, 1);
      assert.deepEqual(Y.encodeStateVector(h.live), vector, 'deletion does not advance the Yjs state vector');
      await assert.rejects(h.create(h.intent(read.metadata.source), 'deleted-source-request', '10 EUR', '12 EUR'), expectedCode('PROPOSAL_CURRENT_CHANGED'));
      assert.equal(h.controls.buildCalls, derived ? 1 : 0);
      assert.equal(h.stored.operations.size, derived ? 1 : 0);
    } finally { h.close(); }
  }
});

test('current mutation during asynchronous target preparation rolls back proposal artifacts and operation', async () => {
  const h = harness();
  try {
    const read = await h.readCurrent();
    const artifactsBefore = h.stored.artifacts.size;
    await assert.rejects(h.service.create({ scope, actorId: 'agent', idempotencyKey: 'during-preparation-request',
      proposal: h.intent(read.metadata.source), mutation: { replacement: parentContent },
      buildTargets: async ({ update }) => {
        const targets = targetsFor(update, baseContent, parentContent);
        h.live.getText('content').delete(0, 1);
        return targets;
      },
    }), expectedCode('PROPOSAL_CURRENT_CHANGED'));
    assert.equal(h.stored.nodes.size, 0);
    assert.equal(h.stored.operations.size, 0);
    assert.equal(h.stored.artifacts.size, artifactsBefore);
  } finally { h.close(); }
});

test('PG-S09 rejected, superseded and expired parents cannot be read or extended as live sources', async () => {
  for (const lifecycle of ['rejected', 'superseded', 'expired'] as const) {
    const h = harness();
    try {
      const parent = await h.parent();
      const read = await h.readProposal(parent.node.proposalId);
      h.stored.nodes.get(parent.node.proposalId)!.lifecycle = lifecycle;
      await assert.rejects(h.readProposal(parent.node.proposalId), expectedCode('PROPOSAL_DEPENDENCY_BLOCKED'));
      await assert.rejects(h.create(h.intent(read.metadata.source), `closed-${lifecycle}`, '100 EUR', '150 EUR'), expectedCode('PROPOSAL_DEPENDENCY_BLOCKED'));
      assert.equal(h.stored.operations.size, 1);
    } finally { h.close(); }
  }
});

test('PG-S25 descendant read authorization covers its complete ancestor closure', async () => {
  const h = harness();
  try {
    const parent = await h.parent();
    const parentRead = await h.readProposal(parent.node.proposalId);
    const child = await h.create(h.intent(parentRead.metadata.source), 'child-request', '100 EUR', '150 EUR');
    const childRead = await h.readProposal(child.node.proposalId);
    h.controls.denyRead.add(parent.node.proposalId);
    await assert.rejects(h.readProposal(child.node.proposalId), expectedCode('PROPOSAL_ACCESS_DENIED'));
    await assert.rejects(h.create(h.intent(childRead.metadata.source), 'denied-grandchild', '150 EUR', '200 EUR'), expectedCode('PROPOSAL_ACCESS_DENIED'));
    assert.ok(h.controls.authorizations.some((entry) => entry.action === 'read'
      && entry.proposalIds.includes(parent.node.proposalId) && entry.proposalIds.includes(child.node.proposalId)));
    assert.equal(h.stored.operations.size, 2);
  } finally { h.close(); }
});

test('PG-S08 replacement and alternative declarations require explicit relationship orchestration', async () => {
  const h = harness();
  try {
    const original = await h.parent();
    const source = (await h.readCurrent()).metadata.source;
    const target = { proposalId: original.node.proposalId, expectedCasVersion: 1,
      expectedCandidateHash: original.node.authoredCandidate.cumulativeCandidate.sha256 };
    for (const kind of ['replacement', 'alternative'] as const) {
      const request: ProposalToolEditV1 = { ...h.intent(source),
        creationKind: kind === 'replacement' ? 'replacement' : 'independent',
        replaces: kind === 'replacement' ? target : null,
        choice: kind === 'alternative' ? { kind: 'alternative_to', ...target } : null };
      await assert.rejects(h.create(request, `unsupported-${kind}`, baseContent, 'Alternative'), expectedCode('PROPOSAL_UPGRADE_REQUIRED'));
    }
    assert.equal(h.stored.nodes.get(original.node.proposalId)!.lifecycle, 'open');
    assert.equal(h.stored.nodes.get(original.node.proposalId)!.casVersion, 1);
    assert.equal(h.stored.groups.size, 0);
    assert.equal(h.stored.operations.size, 1);
  } finally { h.close(); }
});

test('PG-S18 retry of a resolved proposal is stable; an orphan operation instead blocks recovery', async () => {
  const h = harness();
  try {
    const read = await h.readCurrent();
    const request = h.intent(read.metadata.source);
    const parent = await h.create(request, 'stable-request', baseContent, parentContent);
    h.stored.nodes.get(parent.node.proposalId)!.relationships.choiceGroupId = 'later-choice';
    h.stored.groups.set('later-choice', { groupId: 'later-choice', groupRevision: 1,
      dependencyProposalId: null, memberProposalIds: [parent.node.proposalId], chosenProposalId: null });
    h.stored.nodes.get(parent.node.proposalId)!.lifecycle = 'rejected';
    h.stored.nodes.get(parent.node.proposalId)!.casVersion = 2;
    h.live.getText('content').delete(0, 1);
    const retry = await h.create(request, 'stable-request', baseContent, parentContent);
    assert.equal(retry.reused, true);
    assert.equal(retry.node.lifecycle, 'rejected');
    assert.equal(retry.node.proposalId, parent.node.proposalId);
    assert.equal(retry.node.casVersion, 2, 'the current node remains independently observable');
    assert.equal(retry.node.relationships.choiceGroupId, 'later-choice');
    assert.deepEqual(retry.proposal, parent.proposal, 'creation receipt retains its initial CAS and authored relationships');
    assert.deepEqual(retry.authoringPreview, parent.authoringPreview, 'retry preserves the original source and proposed text');
    h.stored.nodes.delete(parent.node.proposalId);
    await assert.rejects(h.create(request, 'stable-request', baseContent, parentContent), expectedCode('PROPOSAL_RECOVERY_REQUIRED'));
    assert.equal(h.controls.buildCalls, 1);
    assert.equal(h.stored.operations.size, 1);
  } finally { h.close(); }
});

test('tool result metadata forces review while legacy outcomes and stable conflict codes remain unchanged', async () => {
  const h = harness();
  try {
    const parent = await h.parent();
    const legacy: AgentFileChangeResult = { path: 'notes.txt', resolvedPath: '/private/notes.txt', changed: true,
      snapshot: null, beforeSha256: sha256(baseContent), afterSha256: sha256(baseContent), size: baseContent.length,
      diff: '', validation: { ok: true, checks: [] },
      collaboration: { operationId: parent.node.operationId, operationStatus: 'needs_review', durability: 'needs_review',
        reviewRequired: false, proposedSha256: sha256(parentContent) } };
    for (const operation of ['write', 'edit_file', 'apply_patch'] as const) {
      const result = asAgentFileToolSuccess({ ...legacy, proposal: parent.proposal }, operation);
      assert.equal(result.outcome, 'review_required');
      assert.equal(result.collaboration?.reviewRequired, true);
      assert.equal(result.recommendedAction, 'review_in_editor');
      assert.equal(Object.hasOwn(result, 'resolvedPath'), false);
      assert.equal(asAgentFileToolSuccess(legacy, operation).outcome, 'applied');
      assert.equal(asAgentFileToolSuccess({ ...legacy, changed: false }, operation).outcome, 'unchanged');
      const error = asAgentFileToolError(new ProposalGraphContractError('PROPOSAL_PARENT_CHANGED', 'Read exact source again'), operation, legacy.path);
      assert.equal(error.code, 'PROPOSAL_PARENT_CHANGED');
      assert.equal(error.category, 'safety_conflict');
      assert.equal(error.recommendedAction, 'read_then_retry');
      assert.equal(error.safeToAutoRetry, false);
    }
  } finally { h.close(); }
});
