import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type * as YTypes from 'yjs';

import { Y } from '../app/lib/collaboration/server-runtime';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import {
  PROPOSAL_GRAPH_ERROR_CODES as Codes,
  type ProposalArtifactReferenceV1,
  type ProposalDocumentScopeV1,
  type ProposalGraphSnapshotV1,
  type ProposalNodeV1,
} from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { hashProposalValue } from '../app/lib/file-version-center/proposal-action-fence';
import { evaluateProposalReview } from '../app/lib/file-version-center/proposal-review-evaluation';
import type { ProposalGraphStorageTransaction } from '../app/lib/file-version-center/proposal-storage';
import {
  authorProposalYjsCandidate,
  proposalYjsCurrentProof,
  type AuthoredProposalYjsCandidate,
} from '../app/lib/file-version-center/proposal-yjs-candidate';
import { createAgentTextTarget } from '../app/lib/collaboration/agent-operations';

const scope: ProposalDocumentScopeV1 = {
  workspaceId: 'workspace-evaluation', lineageId: 'lineage-evaluation', documentId: 'document-evaluation',
  lifecycleGeneration: 1, schemaVersion: 1,
};

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');
const ref = (id: string, bytes: Uint8Array) => ({ ref: id, sha256: digest(bytes), sizeBytes: bytes.byteLength });
const snapshotRef = (id: string, bytes: Uint8Array) => ({ ...ref(id, bytes), encoding: 'yjs_full_update_v1' as const });

function update(doc: YTypes.Doc): Uint8Array { return Y.encodeStateAsUpdate(doc); }

function edit(source: Uint8Array, search: string, replacement: string): AuthoredProposalYjsCandidate {
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, source);
    const text = doc.getText('content');
    const from = text.toString().indexOf(search);
    return authorProposalYjsCandidate({
      sourceUpdate: source, representation: 'plain_text',
      targets: [createAgentTextTarget({ text, from, to: from + search.length, replacement })],
    });
  } finally { doc.destroy(); }
}

function proposal(input: {
  proposalId: string; source: Uint8Array; candidate: AuthoredProposalYjsCandidate; artifacts: Map<string, Uint8Array>;
  dependency?: ProposalNodeV1;
}): ProposalNodeV1 {
  const sourceProof = proposalYjsCurrentProof({ update: input.source, representation: 'plain_text', revisionId: 'revision-base' });
  const sourceSnapshot = snapshotRef(`source-${input.proposalId}`, input.source);
  const sourceAnchor = ref(`source-anchor-${input.proposalId}`, encode({ source: input.proposalId }));
  const incremental = ref(`increment-${input.proposalId}`, input.candidate.incrementalPayload);
  const cumulative = snapshotRef(`candidate-${input.proposalId}`, input.candidate.cumulativeCandidate);
  const witnesses = encode({
    contractVersion: 1, kind: 'proposal_candidate_witnesses',
    effectPreconditions: JSON.parse(new TextDecoder().decode(input.candidate.effectPreconditions)),
    anchorMap: JSON.parse(new TextDecoder().decode(input.candidate.anchorMap)),
  });
  const effects = ref(`witness-${input.proposalId}`, witnesses);
  for (const [artifact, bytes] of [[sourceSnapshot.ref, input.source], [sourceAnchor.ref, encode({ source: input.proposalId })],
    [incremental.ref, input.candidate.incrementalPayload], [cumulative.ref, input.candidate.cumulativeCandidate], [effects.ref, witnesses]] as const) {
    input.artifacts.set(artifact, bytes);
  }
  const source = input.dependency ? {
    kind: 'proposal' as const, scope, current: sourceProof, snapshot: sourceSnapshot, anchorMap: sourceAnchor,
    proposalId: input.dependency.proposalId, proposalCasVersion: input.dependency.casVersion,
    authoredCandidateHash: input.dependency.authoredCandidate.cumulativeCandidate.sha256,
    candidateHash: input.dependency.authoredCandidate.cumulativeCandidate.sha256, evaluationId: null,
  } : { kind: 'authoritative' as const, scope, current: sourceProof, snapshot: sourceSnapshot, anchorMap: sourceAnchor };
  return {
    contractVersion: 1, proposalId: input.proposalId, operationId: `operation-${input.proposalId}`, scope, casVersion: 1,
    source, relationships: { dependency: input.dependency ? {
      proposalId: input.dependency.proposalId, candidateHash: input.dependency.authoredCandidate.cumulativeCandidate.sha256,
    } : null, replacesProposalId: null, choiceGroupId: null },
    authoredCandidate: {
      incrementalPayload: incremental, cumulativeCandidate: cumulative, effectPreconditions: effects,
      sourceProofHash: hashProposalValue(source),
    },
    lifecycle: 'open', createdAt: 1, createdByActorId: 'agent-evaluation',
  };
}

function memoryTransaction(graph: ProposalGraphSnapshotV1, artifacts: Map<string, Uint8Array>) {
  const evaluations: unknown[] = [];
  const reads: string[] = [];
  let put = 0;
  const transaction = {
    loadGraph: async () => graph,
    readArtifact: async (value: ProposalArtifactReferenceV1) => {
      reads.push(value.ref);
      const bytes = artifacts.get(value.ref);
      if (!bytes || digest(bytes) !== value.sha256) throw new Error('artifact mismatch');
      return Uint8Array.from(bytes);
    },
    putArtifact: async (encoding: 'json_v1' | 'yjs_full_update_v1', bytes: Uint8Array) => {
      const id = `evaluation-artifact-${++put}`;
      artifacts.set(id, Uint8Array.from(bytes));
      return { ref: id, sha256: digest(bytes), sizeBytes: bytes.byteLength, encoding };
    },
    putEvaluation: async (value: unknown) => { evaluations.push(value); },
  } as unknown as ProposalGraphStorageTransaction;
  return { transaction, evaluations, reads };
}

function setup() {
  const doc = createPlainTextYDoc('A=1 B=2');
  const artifacts = new Map<string, Uint8Array>();
  const base = update(doc);
  const p1Candidate = edit(base, 'A=1', 'A=10');
  const p1 = proposal({ proposalId: 'p1', source: base, candidate: p1Candidate, artifacts });
  const p2 = proposal({ proposalId: 'p2', source: p1Candidate.cumulativeCandidate,
    candidate: edit(p1Candidate.cumulativeCandidate, 'B=2', 'B=20'), artifacts, dependency: p1 });
  const graph: ProposalGraphSnapshotV1 = { contractVersion: 1, scope, graphRevision: 7, nodes: [p1, p2], choiceGroups: [] };
  return { doc, base, artifacts, graph };
}

test('evaluates an exact batch after authorizing the full closure and persists immutable evidence', async () => {
  const { doc, artifacts, graph } = setup();
  try {
    const current = update(doc);
    const { transaction, evaluations, reads } = memoryTransaction(graph, artifacts);
    let authorized = false;
    const result = await evaluateProposalReview({
      scope, selectedProposalIds: ['p1', 'p2'], transaction,
      loadCurrent: async () => ({ scope, representation: 'plain_text', revisionId: 'revision-current', update: current }),
      confirmCurrent: async () => ({ scope, representation: 'plain_text', revisionId: 'revision-current', update: current }),
      authorize: async ({ proposalIds }) => {
        assert.equal(reads.length, 0, 'authorization must precede artifact reads');
        assert.deepEqual(proposalIds, ['p1', 'p2']); authorized = true;
      },
      now: () => 100, createId: () => 'evaluation-batch',
    });
    assert.equal(authorized, true);
    assert.equal(result.status, 'clean', JSON.stringify(result));
    assert.equal(result.actionability, 'accept');
    assert.equal(result.candidateContent, 'A=10 B=20');
    assert.equal(result.graphRevision, 7);
    assert.match(result.selectionHash ?? '', /^[a-f0-9]{64}$/);
    assert.equal(result.evaluation?.selectionHash, result.selectionHash);
    assert.deepEqual(result.selectedProposalIds, ['p1', 'p2']);
    assert.deepEqual(result.applyProposalIds, ['p1', 'p2']);
    assert.equal(evaluations.length, 1);
    assert.equal(result.evaluation?.evaluationId, 'evaluation-batch');
    assert.equal(result.effectiveCandidate?.encoding, 'yjs_full_update_v1');
    assert.equal([...artifacts.keys()].filter((key) => key.startsWith('evaluation-artifact-')).length, 3);
  } finally { doc.destroy(); }
});

test('rejects duplicate selection before authorization or artifact reads', async () => {
  const { doc, base, artifacts, graph } = setup();
  try {
    const { transaction, reads } = memoryTransaction(graph, artifacts);
    let authorizationCalls = 0;
    const result = await evaluateProposalReview({
      scope, selectedProposalIds: ['p1', 'p1'], transaction,
      loadCurrent: async () => ({ scope, representation: 'plain_text', revisionId: 'revision-current', update: base }),
      authorize: async () => { authorizationCalls += 1; },
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reasonCode, Codes.invalidRequest);
    assert.equal(authorizationCalls, 0);
    assert.equal(reads.length, 0);
  } finally { doc.destroy(); }
});

test('fails closed when authoritative current changes before immutable evidence is written', async () => {
  const { doc, base, artifacts, graph } = setup();
  try {
    const changed = createPlainTextYDoc('A=1 B=2 changed');
    try {
      const { transaction, evaluations } = memoryTransaction(graph, artifacts);
      const result = await evaluateProposalReview({
        scope, selectedProposalIds: ['p1'], transaction,
        loadCurrent: async () => ({ scope, representation: 'plain_text', revisionId: 'revision-current', update: base }),
        confirmCurrent: async () => ({ scope, representation: 'plain_text', revisionId: 'revision-next', update: update(changed) }),
        authorize: async () => undefined,
      });
      assert.equal(result.status, 'unavailable');
      assert.equal(result.reasonCode, Codes.currentChanged);
      assert.equal(result.evaluation?.reasonCode, Codes.currentChanged);
      assert.equal(evaluations.length, 1);
    } finally { changed.destroy(); }
  } finally { doc.destroy(); }
});

test('does not read artifacts whose immutable source proof was tampered with', async () => {
  const { doc, base, artifacts, graph } = setup();
  try {
    graph.nodes[0] = { ...graph.nodes[0]!, authoredCandidate: { ...graph.nodes[0]!.authoredCandidate, sourceProofHash: '0'.repeat(64) } };
    const { transaction, reads } = memoryTransaction(graph, artifacts);
    const result = await evaluateProposalReview({
      scope, selectedProposalIds: ['p1'], transaction,
      loadCurrent: async () => ({ scope, representation: 'plain_text', revisionId: 'revision-current', update: base }),
      authorize: async () => undefined,
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reasonCode, Codes.sourceInvalid);
    assert.equal(reads.length, 0);
  } finally { doc.destroy(); }
});
