import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectProposalReviewPage } from '../app/lib/file-version-center/proposal-review-projection-service';
import type { ProposalGraphSnapshotV1, ProposalNodeV1 } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import { independentProposalFixture, proposalScopeFixture, rootProposalFixture } from './fixtures/proposal-graph-contract-v1';

const makeGraph = (count = 4, revision = 7): ProposalGraphSnapshotV1 => ({
  contractVersion: 1 as const, scope: proposalScopeFixture, graphRevision: revision,
  nodes: [rootProposalFixture, { ...independentProposalFixture, proposalId: 'p2', operationId: 'op-p2', createdAt: 2 },
    ...Array.from({ length: Math.max(0, count - 2) }, (_, index) => ({ ...independentProposalFixture, proposalId: `p${index + 3}`, operationId: `op-p${index + 3}`, createdAt: index + 3 }))] as unknown as ProposalNodeV1[],
  choiceGroups: [],
} as unknown as ProposalGraphSnapshotV1);
const read = { canRead: true, canWrite: false, canManage: false };

test('paginates with a revision-bound cursor without duplicates', () => {
  const graph = makeGraph(5);
  const first = projectProposalReviewPage({ graph, permission: read, limit: 2 });
  assert.equal(first.items.length, 2); assert.ok(first.page.nextCursor);
  const second = projectProposalReviewPage({ graph, permission: read, cursor: first.page.nextCursor, limit: 2 });
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.proposalId)).size, 4);
  assert.equal(second.page.cursorRevision, graph.graphRevision);
});

test('stale cursor fails closed without leaking selected or hidden IDs', () => {
  const first = projectProposalReviewPage({ graph: makeGraph(3, 1), permission: read, limit: 1 });
  const stale = projectProposalReviewPage({ graph: makeGraph(3, 2), permission: read, cursor: first.page.nextCursor });
  assert.equal(stale.diagnosis.reasonCode, 'graph_changed'); assert.deepEqual(stale.items, []); assert.deepEqual(stale.selectedProposalIds, []);
});

test('selected deep link includes its ancestor once', () => {
  const graph = makeGraph(2);
  const child = { ...rootProposalFixture, proposalId: 'child', operationId: 'op-child', createdAt: rootProposalFixture.createdAt + 1, relationships: { ...rootProposalFixture.relationships, dependency: { proposalId: 'p1', candidateHash: '8'.repeat(64) } } };
  graph.nodes = [rootProposalFixture, child] as unknown as ProposalNodeV1[];
  const page = projectProposalReviewPage({ graph, permission: read, selectedProposalIds: ['child'], limit: 10 });
  assert.deepEqual(page.items.map((item) => item.proposalId), ['p1', 'child']);
  assert.equal(new Set(page.items.map((item) => item.proposalId)).size, page.items.length);
  assert.equal(page.items[0].relation, 'root');
  assert.equal(page.items[1].relation, 'dependency');
});

test('foreign roots stay out of the requested root feed and hidden parents fail closed', () => {
  const graph = makeGraph(2);
  graph.nodes.push({ ...rootProposalFixture, proposalId: 'foreign', operationId: 'op-foreign', createdAt: 9 } as unknown as ProposalNodeV1);
  const page = projectProposalReviewPage({ graph, permission: read, rootProposalId: 'p1', limit: 20 });
  assert.ok(page.items.every((item) => item.rootProposalId === 'p1'));
  const hidden = projectProposalReviewPage({ graph, permission: { ...read, readableProposalIds: ['child'] }, selectedProposalIds: ['child'] });
  assert.equal(hidden.diagnosis.reasonCode, 'access_denied'); assert.deepEqual(hidden.items, []);
});

test('invalid page limits fail closed', () => {
  const page = projectProposalReviewPage({ graph: makeGraph(), permission: read, limit: 0 });
  assert.equal(page.diagnosis.reasonCode, 'limit_exceeded'); assert.deepEqual(page.items, []);
});

test('unauthorized selected proposal and hidden parent expose no IDs', () => {
  const graph = makeGraph(2);
  const denied = projectProposalReviewPage({ graph, permission: { ...read, canRead: false }, selectedProposalIds: ['p1'] });
  assert.equal(denied.diagnosis.reasonCode, 'access_denied'); assert.deepEqual(denied.items, []); assert.deepEqual(denied.authorizedProposalIds, []);
});

test('page size is bounded and read/write actionability is separate', () => {
  const graph = makeGraph(120);
  const page = projectProposalReviewPage({ graph, permission: { canRead: true, canWrite: true, canManage: false, ownedProposalIds: ['p1'] }, selectedProposalIds: ['p1'], limit: 256 });
  assert.ok(page.items.length <= 256); assert.equal(page.actionability.read, 'available'); assert.equal(page.actionability.compare, 'available');
  assert.equal(page.actionability.write, 'available'); assert.equal(page.actionability.accept, 'available');
  graph.nodes[1] = { ...graph.nodes[1], relationships: { ...graph.nodes[1].relationships, dependency: { proposalId: 'p1', candidateHash: '8'.repeat(64) } } };
  const mixed = projectProposalReviewPage({ graph, permission: { canRead: true, canWrite: true, canManage: false, ownedProposalIds: ['p1'] }, selectedProposalIds: ['p1', 'p2'], limit: 1 });
  assert.deepEqual(mixed.selectedProposalIds, ['p1', 'p2']);
  assert.equal(mixed.actionability.accept, 'denied', 'one owned proposal must not authorize a mixed batch');
});

test('a deep link cannot mix selections from another root', () => {
  const graph = makeGraph(2);
  graph.nodes.push({ ...rootProposalFixture, proposalId: 'foreign', operationId: 'op-foreign', createdAt: 9 } as unknown as ProposalNodeV1);
  const page = projectProposalReviewPage({ graph, permission: read, rootProposalId: 'p1', selectedProposalIds: ['foreign'] });
  assert.equal(page.diagnosis.reasonCode, 'scope_mismatch');
  assert.deepEqual(page.items, []);
  assert.deepEqual(page.selectedProposalIds, []);
});

test('replacement, alternative and detached relation kinds remain explicit', () => {
  const graph = makeGraph(1);
  graph.nodes = [
    rootProposalFixture,
    { ...independentProposalFixture, proposalId: 'replacement', operationId: 'op-r', relationships: { ...independentProposalFixture.relationships, replacesProposalId: 'p1' } },
    { ...independentProposalFixture, proposalId: 'alternative', operationId: 'op-a', relationships: { ...independentProposalFixture.relationships, choiceGroupId: 'choice' } },
  ] as unknown as ProposalNodeV1[];
  const page = projectProposalReviewPage({ graph, permission: read, limit: 10 });
  assert.deepEqual(new Set(page.items.map((item) => item.relation)), new Set(['root', 'replacement', 'alternative']));
});
