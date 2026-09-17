import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  PROPOSAL_GRAPH_LIMITS,
  type ProposalChoiceGroupV1,
  type ProposalGraphSnapshotV1,
  type ProposalNodeV1,
} from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import {
  resolveProposalChoiceClosure,
  resolveProposalClosure,
  resolveProposalRejection,
  validateProposalGraph,
} from '../app/lib/file-version-center/proposal-graph-model';

const scope = {
  workspaceId: 'model-workspace', lineageId: 'model-lineage', documentId: 'model-document',
  lifecycleGeneration: 1, schemaVersion: 1,
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const artifact = (name: string) => ({ ref: name, sha256: hash(name), sizeBytes: 100 });
const snapshot = (name: string) => ({ ...artifact(name), encoding: 'yjs_full_update_v1' as const });
const current = {
  revisionId: 'v0', contentHash: hash('content'), structureHash: hash('structure'),
  stateVectorHash: hash('vector'), deleteSetHash: hash('deletions'), fullStateHash: hash('full'),
};

/** Explicit wire fixtures: no production closure or candidate builder supplies an oracle. */
function proposal(id: string, parent: ProposalNodeV1 | null = null, lifecycle: ProposalNodeV1['lifecycle'] = 'open'): ProposalNodeV1 {
  const source = {
    scope: { ...scope }, current: { ...current }, snapshot: snapshot('source-v0'), anchorMap: artifact('anchors-v0'),
  };
  return {
    contractVersion: 1, proposalId: id, operationId: `operation-${id}`, scope: { ...scope },
    casVersion: lifecycle === 'open' ? 1 : 2, createdAt: 100, createdByActorId: 'agent', lifecycle,
    source: parent ? {
      ...source, kind: 'proposal', proposalId: parent.proposalId, proposalCasVersion: 1,
      candidateHash: parent.authoredCandidate.cumulativeCandidate.sha256,
      authoredCandidateHash: parent.authoredCandidate.cumulativeCandidate.sha256, evaluationId: null,
      snapshot: { ...parent.authoredCandidate.cumulativeCandidate },
    } : { ...source, kind: 'authoritative' },
    relationships: {
      dependency: parent ? { proposalId: parent.proposalId, candidateHash: parent.authoredCandidate.cumulativeCandidate.sha256 } : null,
      replacesProposalId: null, choiceGroupId: null,
    },
    authoredCandidate: {
      incrementalPayload: artifact(`increment-${id}`), cumulativeCandidate: snapshot(`candidate-${id}`),
      effectPreconditions: artifact(`preconditions-${id}`), sourceProofHash: hash(`source-proof-${id}`),
    },
  };
}

function graph(nodes: ProposalNodeV1[], choiceGroups: ProposalChoiceGroupV1[] = []): ProposalGraphSnapshotV1 {
  return { contractVersion: 1, scope: { ...scope }, graphRevision: 7, nodes, choiceGroups };
}

function group(nodes: ProposalNodeV1[], id = 'choice'): ProposalChoiceGroupV1 {
  for (const node of nodes) node.relationships.choiceGroupId = id;
  return {
    groupId: id, groupRevision: 3, dependencyProposalId: nodes[0].relationships.dependency?.proposalId ?? null,
    memberProposalIds: nodes.map((node) => node.proposalId), chosenProposalId: null,
  };
}

function chain(length: number, prefix = 'chain'): ProposalNodeV1[] {
  const nodes: ProposalNodeV1[] = [];
  for (let index = 0; index < length; index++) nodes.push(proposal(`${prefix}-${index}`, nodes.at(-1) ?? null));
  return nodes;
}

function ready(result: ReturnType<typeof resolveProposalClosure>) {
  assert.equal(result.status, 'ready', JSON.stringify(result));
  if (result.status !== 'ready') throw new Error('Expected structural closure');
  return result;
}

function blocked(result: { status: string; reasonCode?: string }, reasonCode: string): void {
  assert.equal(result.status, 'blocked', JSON.stringify(result));
  assert.equal(result.reasonCode, reasonCode);
}

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

test('PG-S03 child-first includes exactly its parent once, without mutating graph', () => {
  const p1 = proposal('p1');
  const input = graph([proposal('q'), proposal('p2', p1), p1]);
  const before = JSON.stringify(input);
  const result = ready(resolveProposalClosure({ graph: input, selectedProposalIds: ['p2'] }));
  assert.deepEqual(result.dependencyProposalIds, ['p1', 'p2']);
  assert.deepEqual(result.applyProposalIds, ['p1', 'p2']);
  assert.deepEqual(result.closureProposalIds, ['p1', 'p2']);
  assert.deepEqual(result.prerequisiteProposalIds, []);
  assert.deepEqual(result.choiceResolutions, []);
  assert.equal(JSON.stringify(input), before);
});

test('PG-S04/S11 historical parent requires current proof and is never replayed', () => {
  for (const lifecycle of ['applied', 'included', 'satisfied_elsewhere'] as const) {
    const p1 = proposal('p1', null, lifecycle);
    const result = ready(resolveProposalClosure({ graph: graph([p1, proposal('p2', p1)]), selectedProposalIds: ['p2'] }));
    assert.deepEqual(result.dependencyProposalIds, ['p1', 'p2']);
    assert.deepEqual(result.closureProposalIds, ['p1', 'p2']);
    assert.deepEqual(result.applyProposalIds, ['p2']);
    assert.deepEqual(result.prerequisiteProposalIds, ['p1'], 'historical lifecycle is not evidence that its current effect remains');
  }
});

test('PG-S03 terminal selections cannot be applied again after child-first acceptance', () => {
  const p1 = proposal('p1', null, 'included');
  const p2 = proposal('p2', p1, 'applied');
  for (const selected of ['p1', 'p2']) blocked(resolveProposalClosure({
    graph: graph([p1, p2]), selectedProposalIds: [selected],
  }), 'PROPOSAL_INVALID_TRANSITION');
});

test('PG-S07 explicit selection order is stable while shared ancestors and duplicates are unique', () => {
  const p1 = proposal('p1');
  const nodes = [proposal('p2', p1), proposal('q'), p1, proposal('p3', p1)];
  const result = ready(resolveProposalClosure({ graph: graph(nodes), selectedProposalIds: ['p3', 'p2', 'p1', 'p3', 'q'] }));
  assert.deepEqual(result.selectedProposalIds, ['p3', 'p2', 'p1', 'q']);
  assert.deepEqual(result.dependencyProposalIds, ['p1', 'p3', 'p2', 'q']);
  assert.deepEqual(result.applyProposalIds, ['p1', 'p3', 'p2', 'q']);
  assert.deepEqual(result, ready(resolveProposalClosure({ graph: graph([...nodes].reverse()), selectedProposalIds: ['p3', 'p2', 'p1', 'p3', 'q'] })));
});

test('PG-S06 ordinary siblings remain independent of alternative choice semantics', () => {
  const p1 = proposal('p1');
  const result = ready(resolveProposalClosure({ graph: graph([p1, proposal('p2', p1), proposal('p3', p1)]), selectedProposalIds: ['p2'] }));
  assert.deepEqual(result.choiceResolutions, []);
  assert.deepEqual(result.blockedDescendantProposalIds, []);
  assert.deepEqual(result.closureProposalIds, ['p1', 'p2']);
});

test('PG-S10 selecting a child visibly resolves its parent alternative, not the other descendants', () => {
  const p1 = proposal('p1');
  const a = proposal('a');
  const choice = group([p1, a]);
  const result = ready(resolveProposalClosure({ graph: graph([proposal('a2', a), p1, a, proposal('p2', p1)], [choice]), selectedProposalIds: ['p2'] }));
  assert.deepEqual(result.dependencyProposalIds, ['p1', 'p2']);
  assert.deepEqual(result.applyProposalIds, ['p1', 'p2']);
  assert.deepEqual(result.choiceResolutions, [{ groupId: 'choice', groupRevision: 3, chosenProposalId: 'p1', closingProposalIds: ['a'] }]);
  assert.deepEqual(result.closureProposalIds, ['p1', 'p2', 'a']);
  assert.deepEqual(result.blockedDescendantProposalIds, ['a2']);
});

test('PG-S10 direct and indirect alternative conflicts block the whole selection', () => {
  const p1 = proposal('p1');
  const a = proposal('a');
  const choice = group([p1, a]);
  const input = graph([p1, a, proposal('p2', p1), proposal('a2', a)], [choice]);
  const before = JSON.stringify(input);
  for (const selectedProposalIds of [['p1', 'a'], ['p2', 'a'], ['p2', 'a2']]) {
    blocked(resolveProposalClosure({ graph: input, selectedProposalIds }), 'PROPOSAL_CHOICE_CONFLICT');
  }
  assert.equal(JSON.stringify(input), before);
});

test('direct choice helper rejects incomplete or prohibited prerequisite closure', () => {
  const p1 = proposal('p1');
  const p2 = proposal('p2', p1);
  const p3 = proposal('p3', p1);
  const choice = group([p2, p3]);
  const input = graph([p1, p2, p3], [choice]);
  const complete = resolveProposalChoiceClosure({ graph: input, requiredProposalIds: ['p1', 'p2'] });
  assert.equal(complete.status, 'ready');
  if (complete.status !== 'ready') return;
  assert.deepEqual(complete.choiceResolutions, [{ groupId: 'choice', groupRevision: 3, chosenProposalId: 'p2', closingProposalIds: ['p3'] }]);
  blocked(resolveProposalChoiceClosure({ graph: input, requiredProposalIds: ['p2'] }), 'PROPOSAL_DEPENDENCY_BLOCKED');
  blocked(resolveProposalChoiceClosure({
    graph: graph([{ ...p1, lifecycle: 'rejected', casVersion: 2 }, p2, p3], [choice]), requiredProposalIds: ['p1', 'p2'],
  }), 'PROPOSAL_DEPENDENCY_BLOCKED');
  blocked(resolveProposalChoiceClosure({ graph: input, requiredProposalIds: ['unknown'] }), 'PROPOSAL_SOURCE_INVALID');
});

test('PG-S08 a replacement retains its real prerequisite and does not apply its superseded original', () => {
  const p1 = proposal('p1');
  const p2 = proposal('p2', p1, 'superseded');
  const p3 = proposal('p3', p1);
  const replacement = proposal('r', p1);
  replacement.relationships.replacesProposalId = 'p2';
  const choice = group([p2, p3, replacement]);
  const result = ready(resolveProposalClosure({ graph: graph([p1, p2, p3, replacement], [choice]), selectedProposalIds: ['r'] }));
  assert.deepEqual(result.dependencyProposalIds, ['p1', 'r']);
  assert.deepEqual(result.applyProposalIds, ['p1', 'r']);
  assert.deepEqual(result.choiceResolutions, [{ groupId: 'choice', groupRevision: 3, chosenProposalId: 'r', closingProposalIds: ['p3'] }]);
});

test('PG-S05/S09 terminally blocked parents affect descendants but not unrelated roots', () => {
  for (const lifecycle of ['rejected', 'superseded', 'expired', 'alternative_not_selected'] as const) {
    const p1 = proposal('p1', null, lifecycle);
    const input = graph([p1, proposal('p2', p1), proposal('q')]);
    blocked(resolveProposalClosure({ graph: input, selectedProposalIds: ['p2'] }), 'PROPOSAL_DEPENDENCY_BLOCKED');
    const independent = ready(resolveProposalClosure({ graph: input, selectedProposalIds: ['q'] }));
    assert.deepEqual(independent.applyProposalIds, ['q']);
  }
});

test('PG-S12 satisfied_elsewhere requires current proof and visible choice approval, without choosing during preview', () => {
  const p1 = proposal('p1', null, 'satisfied_elsewhere');
  const a = proposal('a');
  const choice = group([p1, a]);
  const input = graph([p1, a, proposal('p2', p1)], [choice]);
  const before = JSON.stringify(input);
  const explicit = ready(resolveProposalClosure({ graph: input, selectedProposalIds: ['p2'] }));
  assert.deepEqual(explicit.prerequisiteProposalIds, ['p1']);
  assert.deepEqual(explicit.applyProposalIds, ['p2']);
  assert.deepEqual(explicit.choiceResolutions, [{ groupId: 'choice', groupRevision: 3, chosenProposalId: 'p1', closingProposalIds: ['a'] }]);
  assert.equal(JSON.stringify(input), before, 'only a later signed action can resolve the displayed choice');
  blocked(resolveProposalClosure({ graph: graph(input.nodes, [{ ...choice, chosenProposalId: 'a' }]), selectedProposalIds: ['p2'] }), 'PROPOSAL_CHOICE_CONFLICT');
});

test('PG-S10 historic chosen groups retain their winner and current prerequisite proof', () => {
  const p1 = proposal('p1', null, 'applied');
  const a = proposal('a', null, 'alternative_not_selected');
  const choice = { ...group([p1, a]), chosenProposalId: 'p1' };
  const result = ready(resolveProposalClosure({ graph: graph([p1, a, proposal('p2', p1)], [choice]), selectedProposalIds: ['p2'] }));
  assert.deepEqual(result.prerequisiteProposalIds, ['p1']);
  assert.deepEqual(result.applyProposalIds, ['p2']);
  assert.deepEqual(result.choiceResolutions, [{ groupId: 'choice', groupRevision: 3, chosenProposalId: 'p1', closingProposalIds: [] }]);
});

test('PG-S05 single reject has narrow mutation scope while branch reject covers only open descendants', () => {
  const p1 = proposal('p1');
  const p2 = proposal('p2', p1);
  const p3 = proposal('p3', p2, 'rejected');
  const input = graph([proposal('q'), proposal('p4', p3), p3, p2, p1]);
  const before = JSON.stringify(input);
  const single = resolveProposalRejection({ graph: input, proposalId: 'p1', mode: 'single' });
  assert.equal(single.status, 'ready');
  if (single.status !== 'ready') return;
  assert.deepEqual(single.rejectedProposalIds, ['p1']);
  assert.deepEqual(single.closureProposalIds, ['p1']);
  assert.deepEqual([...single.blockedDescendantProposalIds].sort(), ['p2', 'p4']);
  const branch = resolveProposalRejection({ graph: input, proposalId: 'p1', mode: 'branch' });
  assert.equal(branch.status, 'ready');
  if (branch.status !== 'ready') return;
  assert.deepEqual(branch.rejectedProposalIds, ['p1', 'p2', 'p4']);
  assert.deepEqual(branch.closureProposalIds, ['p1', 'p2', 'p4']);
  assert.equal(JSON.stringify(input), before);
});

test('PG-S05 a blocked child can be rejected without reopening or accepting its rejected parent', () => {
  const p1 = proposal('p1', null, 'rejected');
  const p2 = proposal('p2', p1);
  const input = graph([p1, p2, proposal('p3', p2)]);
  const result = resolveProposalRejection({ graph: input, proposalId: 'p2', mode: 'branch' });
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.deepEqual(result.rejectedProposalIds, ['p2', 'p3']);
  assert.deepEqual(result.closureProposalIds, ['p2', 'p3']);
  blocked(resolveProposalRejection({ graph: input, proposalId: 'p1', mode: 'single' }), 'PROPOSAL_INVALID_TRANSITION');
});

test('PG-S23/S30 malformed scope, missing parent and cycles have distinct stable errors', () => {
  const p1 = proposal('p1');
  const p2 = proposal('p2', p1);
  const foreign = proposal('foreign');
  foreign.scope.workspaceId = 'other';
  foreign.source.scope.workspaceId = 'other';
  blocked(validateProposalGraph(graph([p1, foreign])), 'PROPOSAL_SCOPE_MISMATCH');
  blocked(validateProposalGraph(graph([p2])), 'PROPOSAL_PARENT_CHANGED');
  const cyclicP1 = proposal('p1', p2);
  blocked(validateProposalGraph(graph([cyclicP1, p2])), 'PROPOSAL_CYCLE');
  const r1 = proposal('r1');
  const r2 = proposal('r2');
  r1.relationships.replacesProposalId = 'r2';
  r2.relationships.replacesProposalId = 'r1';
  blocked(validateProposalGraph(graph([r1, r2])), 'PROPOSAL_CYCLE');
});

test('PG-S30 exact depth, root-count, per-root and snapshot limits reject only the excess case', () => {
  assert.equal(validateProposalGraph(graph(chain(PROPOSAL_GRAPH_LIMITS.dependencyDepth + 1))).status, 'valid');
  blocked(validateProposalGraph(graph(chain(PROPOSAL_GRAPH_LIMITS.dependencyDepth + 2))), 'PROPOSAL_LIMIT_EXCEEDED');
  const roots = Array.from({ length: PROPOSAL_GRAPH_LIMITS.openRootsPerDocument }, (_, index) => proposal(`root-${index}`));
  assert.equal(validateProposalGraph(graph(roots)).status, 'valid');
  blocked(validateProposalGraph(graph([...roots, proposal('root-overflow')])), 'PROPOSAL_LIMIT_EXCEEDED');
  const parent = proposal('star');
  const perRoot = [parent, ...Array.from({ length: PROPOSAL_GRAPH_LIMITS.nodesPerRoot - 1 }, (_, index) => proposal(`leaf-${index}`, parent))];
  assert.equal(validateProposalGraph(graph(perRoot)).status, 'valid');
  blocked(validateProposalGraph(graph([...perRoot, proposal('leaf-overflow', parent)])), 'PROPOSAL_LIMIT_EXCEEDED');
  const history = Array.from({ length: PROPOSAL_GRAPH_LIMITS.nodesPerSnapshot }, (_, index) => proposal(`past-${index}`, null, 'rejected'));
  assert.equal(validateProposalGraph(graph(history)).status, 'valid');
  blocked(validateProposalGraph(graph([...history, proposal('past-overflow', null, 'rejected')])), 'PROPOSAL_LIMIT_EXCEEDED');
});

test('PG-S30 batch size and expanded dependency closure have independent exact limits', () => {
  const roots = Array.from({ length: PROPOSAL_GRAPH_LIMITS.batchMembers }, (_, index) => proposal(`batch-${index}`));
  assert.equal(resolveProposalClosure({ graph: graph(roots), selectedProposalIds: roots.map((node) => node.proposalId) }).status, 'ready');
  blocked(resolveProposalClosure({ graph: graph(roots), selectedProposalIds: [...roots.map((node) => node.proposalId), 'overflow'] }), 'PROPOSAL_LIMIT_EXCEEDED');
  const nodes = [proposal('tree-a'), proposal('tree-b')];
  const selected: string[] = [];
  for (let branch = 0; branch < 32; branch++) {
    let parent = nodes[branch % 2];
    for (let depth = 0; depth < (branch === 31 ? 2 : 4); depth++) {
      parent = proposal(`branch-${branch}-${depth}`, parent);
      nodes.push(parent);
    }
    selected.push(parent.proposalId);
  }
  assert.equal(nodes.length, 128);
  assert.equal(ready(resolveProposalClosure({ graph: graph(nodes), selectedProposalIds: selected })).closureProposalIds.length, 128);
  const extension = proposal('closure-overflow', nodes.at(-1)!);
  blocked(resolveProposalClosure({ graph: graph([...nodes, extension]), selectedProposalIds: [...selected.slice(0, -1), extension.proposalId] }), 'PROPOSAL_LIMIT_EXCEEDED');
});

test('PG-S30 open children of historical roots still count toward the active-root bound', () => {
  const roots = Array.from({ length: PROPOSAL_GRAPH_LIMITS.openRootsPerDocument }, (_, index) => proposal(`historical-${index}`, null, 'applied'));
  const nodes = roots.flatMap((root, index) => [root, proposal(`pending-${index}`, root)]);
  assert.equal(validateProposalGraph(graph(nodes)).status, 'valid');
  const extra = proposal('historical-extra', null, 'applied');
  blocked(validateProposalGraph(graph([...nodes, extra, proposal('pending-extra', extra)])), 'PROPOSAL_LIMIT_EXCEEDED');
});

test('PG-S30 directly closing alternatives count toward expanded closure limits', () => {
  const p1 = proposal('p1');
  const alternatives = Array.from({ length: 127 }, (_, index) => proposal(`option-${index}`, p1));
  const choice = group(alternatives);
  assert.equal(ready(resolveProposalClosure({ graph: graph([p1, ...alternatives], [choice]), selectedProposalIds: ['option-0'] })).closureProposalIds.length, 128);
  const q = proposal('q');
  blocked(resolveProposalClosure({ graph: graph([p1, ...alternatives, q], [choice]), selectedProposalIds: ['option-0', 'q'] }), 'PROPOSAL_LIMIT_EXCEEDED');
});

test('empty selection is not an action, but a genuinely empty graph is valid', () => {
  assert.equal(validateProposalGraph(graph([])).status, 'valid');
  blocked(resolveProposalClosure({ graph: graph([]), selectedProposalIds: [] }), 'PROPOSAL_INVALID_REQUEST');
});

test('seeded DAGs preserve exact reachability, uniqueness and topological order under input permutation', () => {
  let seed = 0x51c0ffee;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let trial = 0; trial < 80; trial++) {
    const nodes: ProposalNodeV1[] = [];
    const reach = Array.from({ length: 12 }, (_, i) => Array.from({ length: 12 }, (_, j) => i === j));
    for (let index = 0; index < 12; index++) {
      const parentIndex = index === 0 ? -1 : (random() % (index + 1)) - 1;
      nodes.push(proposal(`n${index}`, parentIndex < 0 ? null : nodes[parentIndex]));
      if (parentIndex >= 0) reach[index][parentIndex] = true;
    }
    // Independent boolean transitive-closure oracle, not the model's traversal.
    for (let via = 0; via < 12; via++) for (let from = 0; from < 12; from++) for (let to = 0; to < 12; to++) {
      reach[from][to] ||= reach[from][via] && reach[via][to];
    }
    const selectedIndexes = [random() % 12, random() % 12, random() % 12];
    const selectedProposalIds = selectedIndexes.map((index) => `n${index}`);
    const expectedSet = nodes.filter((_, index) => selectedIndexes.some((selected) => reach[selected][index])).map((node) => node.proposalId).sort();
    const result = ready(resolveProposalClosure({ graph: graph(nodes), selectedProposalIds }));
    assert.deepEqual([...result.dependencyProposalIds].sort(), expectedSet);
    assert.deepEqual(result.applyProposalIds, result.dependencyProposalIds);
    assert.equal(new Set(result.closureProposalIds).size, result.closureProposalIds.length);
    assert.deepEqual([...result.closureProposalIds].sort(), expectedSet);
    for (const node of nodes) if (expectedSet.includes(node.proposalId) && node.relationships.dependency) {
      assert.ok(result.dependencyProposalIds.indexOf(node.relationships.dependency.proposalId) < result.dependencyProposalIds.indexOf(node.proposalId));
    }
    const shuffled = [...nodes]; // Explicit Fisher-Yates, independent of platform sort behavior.
    for (let index = shuffled.length - 1; index > 0; index--) {
      const swap = random() % (index + 1);
      [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
    }
    assert.deepEqual(ready(resolveProposalClosure({ graph: graph(shuffled), selectedProposalIds })), result);
    const reversed = ready(resolveProposalClosure({ graph: graph(shuffled), selectedProposalIds: [...selectedProposalIds].reverse() }));
    assert.deepEqual([...reversed.applyProposalIds].sort(), expectedSet,
      'selection reversal preserves required set, not a claim of content-level commutativity');
  }
});

console.log(`proposal-graph-model-test: ${passed} groups passed (including 80 seeded DAG cases)`);
